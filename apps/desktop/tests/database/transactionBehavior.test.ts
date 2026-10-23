import { createDrizzleDb } from '@database/driver';
import { getLastTauriInvokeCall, mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

/**
 * 事务开启模式。
 *
 * 回归背景（真实事故）：一轮里模型并行发出多个工具调用，`runToolRound` 用
 * `Promise.all` 并发执行，每个都会写库。应用里的事务几乎都是「先读后写」
 * （`createToolPart` 取 `max(sort_order)` 再插入；`updateToolPart` /
 * `mergeMessagePartData` / `syncOutputParts` 先 SELECT 再 UPDATE）。
 *
 * WAL 下 `BEGIN DEFERRED` 会让第一条 SELECT 先拿到读快照，写的时候才升级；
 * 此时若别的连接已提交过写入，升级立刻返回 SQLITE_BUSY（code 5），
 * 而且 `busy_timeout` 对读快照升级冲突不生效 —— 不重试，直接 `database is locked`。
 * 实测 8 个并发工具日志写入里 7 个失败：工具结果随机丢库、状态卡在 pending，
 * 严重时冒泡到 PersistenceProjector，界面上弹出「数据库错误」。
 *
 * `BEGIN IMMEDIATE` 在事务开始就取写锁，后到的事务由 `busy_timeout` 正常排队，
 * 写入被真正串行化。同一并发场景下实测 24/24 全部成功。
 */
function installTransactionMocks() {
    mockTauriCommand('database_tx_begin', 'tx_1');
    mockTauriCommand('database_tx_query', { rows: [], rowsAffected: 0, lastInsertId: null });
    mockTauriCommand('database_tx_commit', null);
    mockTauriCommand('database_tx_rollback', null);
}

describe('when the app writes several rows together', () => {
    it('user gets a write transaction that locks immediately by default', async () => {
        installTransactionMocks();
        const db = createDrizzleDb();

        await db.transaction(async () => 'done');

        // 默认必须是 immediate：deferred 会在并发「先读后写」时丢写。
        expect(getLastTauriInvokeCall('database_tx_begin')?.payload).toEqual({
            behavior: 'immediate',
        });
    });

    it('user gets the requested transaction mode when one is asked for', async () => {
        installTransactionMocks();
        const db = createDrizzleDb();

        await db.transaction(async () => 'done', { behavior: 'deferred' });

        expect(getLastTauriInvokeCall('database_tx_begin')?.payload).toEqual({
            behavior: 'deferred',
        });
    });

    it('user keeps all or none of a batch of changes', async () => {
        installTransactionMocks();
        const db = createDrizzleDb();

        await db.transaction(async () => 'ok');
        expect(getLastTauriInvokeCall('database_tx_commit')?.cmd).toBe('database_tx_commit');

        await expect(
            db.transaction(async () => {
                throw new Error('write failed');
            })
        ).rejects.toThrow('write failed');
        expect(getLastTauriInvokeCall('database_tx_rollback')?.cmd).toBe('database_tx_rollback');
    });

    it('user gets in-transaction reads served by the same transaction', async () => {
        installTransactionMocks();
        const db = createDrizzleDb();

        await db.transaction(async (tx) => {
            await tx.run('select 1');
        });

        const call = getLastTauriInvokeCall('database_tx_query');
        expect(call?.payload).toMatchObject({ txId: 'tx_1' });
    });
});
