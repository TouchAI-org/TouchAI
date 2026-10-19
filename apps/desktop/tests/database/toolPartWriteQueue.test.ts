import { describe, expect, it } from 'vitest';

/**
 * 并行工具调用的 `sort_order` 分配。
 *
 * 回归背景：一轮里模型并行发出多个工具调用时，`runToolRound` 用 `Promise.all`
 * 并发执行，每个都会 `createBuiltInToolLog` → `createToolPart`。
 * 原来是「先 select max(sort_order) 再 insert」，两个并发事务会读到同一个最大值，
 * 算出相同的序号，后写的把先写的挤掉 —— 表现是工具执行了、UI 也显示了，
 * 但重载后这个调用消失（真实事故：一轮 2 次搜索，只剩 1 条入库）。
 */
describe('tool part write serialization', () => {
    it('serializes concurrent writes so every part gets a distinct sort_order', async () => {
        // 模拟修复后的写入队列
        let chain: Promise<unknown> = Promise.resolve();
        const rows: number[] = [];

        const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
            const scheduled = chain.then(operation, operation);
            chain = scheduled.then(
                () => undefined,
                () => undefined
            );
            return scheduled;
        };

        const createPart = () =>
            enqueue(async () => {
                // 模拟事务内 max(sort_order) + 1
                await Promise.resolve();
                const next = rows.length === 0 ? 0 : Math.max(...rows) + 1;
                rows.push(next);
                return next;
            });

        const assigned = await Promise.all([createPart(), createPart(), createPart()]);

        expect(assigned).toEqual([0, 1, 2]);
        expect(new Set(assigned).size).toBe(3);
    });

    it('demonstrates the collision without serialization', async () => {
        // 不加队列时，并发读到同一个 max
        const rows: number[] = [];
        const createPartUnsafe = async () => {
            const snapshot = rows.length === 0 ? 0 : Math.max(...rows) + 1;
            await Promise.resolve();
            rows.push(snapshot);
            return snapshot;
        };

        const assigned = await Promise.all([
            createPartUnsafe(),
            createPartUnsafe(),
            createPartUnsafe(),
        ]);

        // 三个调用拿到同一个序号 —— 这正是丢片段的根因
        expect(new Set(assigned).size).toBe(1);
    });

    it('keeps the queue alive after a failed write', async () => {
        let chain: Promise<unknown> = Promise.resolve();
        const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
            const scheduled = chain.then(operation, operation);
            chain = scheduled.then(
                () => undefined,
                () => undefined
            );
            return scheduled;
        };

        await expect(
            enqueue(async () => {
                throw new Error('write failed');
            })
        ).rejects.toThrow('write failed');

        await expect(enqueue(async () => 'ok')).resolves.toBe('ok');
    });
});
