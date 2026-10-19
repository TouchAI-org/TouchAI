// 判定事务模式在真实并发（多线程/多连接）下的行为。
//
// node:sqlite 是同步 API，同一进程里的阻塞等待会把事件循环一起卡住，
// 所以这里用 worker 线程模拟「多个连接并发写」：
//   - DEFERRED：事务内先读 max(sort_order) 再写 → 升级读快照失败
//   - IMMEDIATE：事务开始就抢写锁 → 后到者等前者提交（busy_timeout 生效）
//
// 用法：node scripts/verify-tx-mode.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

const dir = mkdtempSync(path.join(tmpdir(), 'touchai-tx-'));
const file = path.join(dir, 'tx.db');

const setup = new DatabaseSync(file);
setup.exec('PRAGMA journal_mode = WAL');
setup.exec(`
    CREATE TABLE message_parts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX message_parts_message_id_sort_order_idx
        ON message_parts (message_id, sort_order);
    INSERT INTO message_parts (message_id, type, sort_order) VALUES (1, 'text', 0);
`);
setup.close();

// worker：连到同一个库，按给定的模式「先读 max、再插入」，中途让出一段时间
const WORKER_SOURCE = `
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');

const conn = new DatabaseSync(workerData.file, { timeout: 5000 });
conn.exec('PRAGMA journal_mode = WAL');
conn.exec('PRAGMA busy_timeout = 5000');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const started = Date.now();
    const result = { label: workerData.label, mode: workerData.mode };
    try {
        conn.exec('BEGIN ' + workerData.mode);
    } catch (error) {
        parentPort.postMessage({ ...result, stage: 'begin', ok: false, ms: Date.now() - started, error: error.message });
        return;
    }
    try {
        const next = conn
            .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM message_parts WHERE message_id = 1')
            .get().next;
        // 模拟真实写入前的 IPC 往返，把冲突窗口拉长
        await sleep(workerData.delayMs);
        conn.prepare(
            'INSERT INTO message_parts (message_id, type, data, sort_order) VALUES (?, ?, ?, ?)'
        ).run(1, 'tool_call', JSON.stringify({ toolCallId: workerData.label }), next);
        conn.exec('COMMIT');
        parentPort.postMessage({ ...result, ok: true, next, ms: Date.now() - started });
    } catch (error) {
        try {
            conn.exec('ROLLBACK');
        } catch {
            // SQLite 可能已自动回滚
        }
        parentPort.postMessage({ ...result, stage: 'write', ok: false, ms: Date.now() - started, error: error.message });
    }
})();
`;

const runWorker = (mode, label, delayMs) =>
    new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_SOURCE, {
            eval: true,
            workerData: { file, mode, label, delayMs },
        });
        // 拿到结果立刻终止 worker：线程活着就会占着 SQLite 连接（锁不会释放），
        // 后面的“最终落库”读会被卡成 database is locked。
        worker.on('message', (message) => {
            void worker.terminate().then(() => resolve(message));
        });
        worker.on('error', reject);
    });

async function scenario(mode) {
    // A 先进入事务并读到 max，B 稍后进入
    const a = runWorker(mode, 'A', 200);
    await new Promise((r) => setTimeout(r, 40));
    const b = runWorker(mode, 'B', 0);
    const outcome = [await a, await b];
    // terminate 是异步的，给文件锁一点释放时间
    await new Promise((r) => setTimeout(r, 150));
    return outcome;
}

console.log('=== BEGIN DEFERRED（当前实现） ===');
console.log(await scenario('DEFERRED'));

console.log('\n=== BEGIN IMMEDIATE ===');
console.log(await scenario('IMMEDIATE'));

console.log('\n=== 最终落库 ===');
{
    const conn = new DatabaseSync(file);
    for (const row of conn
        .prepare('SELECT id, sort_order, data FROM message_parts ORDER BY id')
        .all()) {
        console.log(`id=${row.id} sort_order=${row.sort_order} data=${row.data}`);
    }
    conn.close();
}

rmSync(dir, { recursive: true, force: true });
