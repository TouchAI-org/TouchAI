import { enqueueToolPartWrite } from '@database/queries/toolParts';
import { describe, expect, it } from 'vitest';

/**
 * 回归背景：一轮里模型并行发出多个工具调用时 `runToolRound` 用 `Promise.all`
 * 并发执行，每个都会 `createToolPart`。`message_parts` 上有
 * `UNIQUE(message_id, sort_order)`，两个并发事务读到同一个 `max(sort_order)`
 * 就会算出相同序号，后写的撞唯一索引并回滚整个事务 ——
 * 表现是工具执行了、UI 也显示了，但重载后这个调用消失。
 *
 * 直接跑生产队列 `enqueueToolPartWrite`，不在测试里复刻实现。
 */
describe('tool part write serialization', () => {
    it('does not start the next write until the previous one settles', async () => {
        const events: string[] = [];
        let releaseFirst: () => void = () => undefined;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        // 第一个操作故意卡住，若队列没生效第二个会立刻开始
        const first = enqueueToolPartWrite(async () => {
            events.push('first:start');
            await firstGate;
            events.push('first:end');
            return 0;
        });
        const second = enqueueToolPartWrite(async () => {
            events.push('second:start');
            return 1;
        });

        // 给队列足够的机会去（错误地）启动第二个
        await Promise.resolve();
        await Promise.resolve();
        expect(events).toEqual(['first:start']);

        releaseFirst();
        await expect(Promise.all([first, second])).resolves.toEqual([0, 1]);
        expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    });

    it('assigns distinct sort_order to concurrent writes', async () => {
        const rows: number[] = [];

        const createPart = () =>
            enqueueToolPartWrite(async () => {
                // 故意在读写之间让出：没有队列时三个操作会读到同一个 max
                await Promise.resolve();
                const next = rows.length === 0 ? 0 : Math.max(...rows) + 1;
                await Promise.resolve();
                rows.push(next);
                return next;
            });

        const assigned = await Promise.all([createPart(), createPart(), createPart()]);

        expect(assigned).toEqual([0, 1, 2]);
        expect(new Set(assigned).size).toBe(3);
    });

    it('keeps the queue alive after a failed write', async () => {
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
