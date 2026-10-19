import { enqueueToolPartWrite } from '@database/queries/toolParts';
import { describe, expect, it } from 'vitest';

/**
 * 并行工具调用的 `sort_order` 分配。
 *
 * 回归背景：一轮里模型并行发出多个工具调用时，`runToolRound` 用 `Promise.all`
 * 并发执行，每个都会 `createBuiltInToolLog` → `createToolPart`。
 * 原来是「先 select max(sort_order) 再 insert」，两个并发事务会读到同一个最大值，
 * 算出相同的序号，后写的撞上 `(message_id, sort_order)` 唯一索引并回滚整个事务 ——
 * 表现是工具执行了、UI 也显示了，但重载后这个调用消失（真实事故：一轮 2 次搜索，只剩 1 条入库）。
 *
 * 这里直接跑生产队列 `enqueueToolPartWrite`，而不是在测试里复刻一份实现 ——
 * 复刻版在队列被删掉或改坏时仍然会通过。
 */
describe('tool part write serialization', () => {
    it('serializes concurrent writes so every part gets a distinct sort_order', async () => {
        const rows: number[] = [];

        // 模拟事务内 `INSERT ... SELECT MAX() + 1`：读到的最大值取决于前面有多少次写入完成
        const createPart = () =>
            enqueueToolPartWrite(async () => {
                // 让出一次微任务，制造并发交错的机会
                await Promise.resolve();
                const next = rows.length === 0 ? 0 : Math.max(...rows) + 1;
                rows.push(next);
                return next;
            });

        const assigned = await Promise.all([createPart(), createPart(), createPart()]);

        expect(assigned).toEqual([0, 1, 2]);
        expect(new Set(assigned).size).toBe(3);
    });

    it('keeps the queue alive after a failed write', async () => {
        // 单次失败不能阻断后续写入，否则一次失败会让余下的工具调用全部丢库。
        await expect(
            enqueueToolPartWrite(async () => {
                throw new Error('write failed');
            })
        ).rejects.toThrow('write failed');

        await expect(enqueueToolPartWrite(async () => 'ok')).resolves.toBe('ok');
    });

    it('runs queued operations in submission order', async () => {
        const order: string[] = [];

        await Promise.all([
            enqueueToolPartWrite(async () => {
                order.push('first');
            }),
            enqueueToolPartWrite(async () => {
                order.push('second');
            }),
            enqueueToolPartWrite(async () => {
                order.push('third');
            }),
        ]);

        expect(order).toEqual(['first', 'second', 'third']);
    });
});
