// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { LiveUsageTracker } from '@services/UsageService/liveUsage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { emitMock } = vi.hoisted(() => ({ emitMock: vi.fn() }));

vi.mock('@services/EventService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@services/EventService')>();
    return {
        ...actual,
        eventService: { emit: emitMock, on: vi.fn(), once: vi.fn() },
    };
});

interface EmittedPayload {
    taskId: string;
    modelName: string;
    outputTokens: number;
    tokensPerSecond: number | null;
    elapsedMs: number;
    ttftMs: number | null;
    estimatedCostMicros: number | null;
    streaming: boolean;
}

function lastPayload(): EmittedPayload {
    const call = emitMock.mock.calls[emitMock.mock.calls.length - 1];
    if (!call) throw new Error('nothing emitted');
    return call[1] as EmittedPayload;
}

function tracker(options: Partial<ConstructorParameters<typeof LiveUsageTracker>[0]> = {}) {
    return new LiveUsageTracker({
        taskId: 'task-1',
        sessionId: 1,
        modelName: 'test-model',
        estimatedOutputCostPerMillion: 10,
        ...options,
    });
}

/** 推进假时间并送入一段文本 */
function feed(instance: LiveUsageTracker, text: string, advanceMs: number) {
    vi.advanceTimersByTime(advanceMs);
    instance.consume({ content: text, done: false });
}

beforeEach(() => {
    emitMock.mockClear();
    vi.useFakeTimers();
});

describe('LiveUsageTracker', () => {
    it('emits nothing before the first content arrives', () => {
        const instance = tracker();
        vi.advanceTimersByTime(1000);

        expect(emitMock).not.toHaveBeenCalled();
        void instance;
    });

    it('emits the very first delta immediately so the panel lights up at once', () => {
        const instance = tracker();

        feed(instance, 'hi', 50);

        expect(emitMock).toHaveBeenCalledTimes(1);
        expect(lastPayload().outputTokens).toBeGreaterThan(0);
    });

    it('does not emit more often than the throttle interval', () => {
        const instance = tracker();

        feed(instance, 'hello', 100);
        const afterFirst = emitMock.mock.calls.length;
        feed(instance, ' world', 50);
        feed(instance, ' again', 50);

        // 后续片段都在 300ms 内，不应再推送
        expect(emitMock).toHaveBeenCalledTimes(afterFirst);
    });

    it('estimates tokens from streamed characters', () => {
        const instance = tracker();

        // 120 个拉丁字符 ≈ 30 token
        feed(instance, 'a'.repeat(120), 400);

        expect(lastPayload().outputTokens).toBe(30);
    });

    it('counts CJK characters as heavier than latin ones', () => {
        const instance = tracker();
        feed(instance, '中'.repeat(12), 400);

        // 12 / 1.5 = 8 token
        expect(lastPayload().outputTokens).toBe(8);
    });

    it('counts reasoning deltas towards throughput', () => {
        const instance = tracker();

        vi.advanceTimersByTime(400);
        instance.consume({ content: '', reasoning: 'a'.repeat(80), done: false });

        expect(lastPayload().outputTokens).toBe(20);
    });

    it('records the first-token latency on the first delta', () => {
        const instance = tracker();

        vi.advanceTimersByTime(750);
        instance.consume({ content: 'hi', done: false });

        // 首字延迟在首个片段时定格，不受后续时间推进影响
        expect(lastPayload().ttftMs).toBe(750);
    });

    it('reports an active stream while streaming', () => {
        const instance = tracker();
        feed(instance, 'x'.repeat(60), 400);

        expect(lastPayload().streaming).toBe(true);
    });

    it('estimates cost from the output price', () => {
        const instance = tracker({ estimatedOutputCostPerMillion: 15 });

        // 300 字符 ≈ 75 token；75 × 15 = 1125 微元
        feed(instance, 'a'.repeat(300), 400);

        expect(lastPayload().estimatedCostMicros).toBe(75 * 15);
    });

    it('omits cost when no price is known', () => {
        const instance = tracker({ estimatedOutputCostPerMillion: null });
        feed(instance, 'a'.repeat(300), 400);

        expect(lastPayload().estimatedCostMicros).toBeNull();
    });

    it('accumulates speed samples internally across pushes', () => {
        const instance = tracker();

        for (let index = 0; index < 5; index += 1) {
            feed(instance, 'a'.repeat(100), 400);
        }

        // 速度由内部采样窗口算出；对外只推当前值，曲线由消费方按节拍聚合
        expect(emitMock.mock.calls.length).toBe(5);
        expect(lastPayload().tokensPerSecond).toBeGreaterThan(0);
    });

    it('measures a steady stream from token counter deltas in the last five seconds', () => {
        const instance = tracker();
        feed(instance, 'a'.repeat(100), 400);
        for (let index = 0; index < 20; index += 1) feed(instance, 'a'.repeat(100), 400);

        // 每 400ms 增加 25 token，即 62.5 tok/s；更早的样本不应摊入窗口。
        expect(lastPayload().tokensPerSecond).toBeCloseTo(62.5, 1);
    });

    it('reports no speed until the first measurable window', () => {
        const instance = tracker();

        feed(instance, 'a'.repeat(100), 50);

        // 宁可不给数字，也不报一个凭空的 0
        expect(lastPayload().tokensPerSecond).toBeNull();
    });

    it('replaces the estimate with the measured token count on finish', () => {
        const instance = tracker();
        feed(instance, 'a'.repeat(400), 400);
        const estimated = lastPayload().outputTokens;

        instance.finish({ outputTokens: 999, costMicros: null });

        const final = lastPayload();
        expect(final.outputTokens).toBe(999);
        expect(final.outputTokens).not.toBe(estimated);
        expect(final.streaming).toBe(false);
    });

    it('keeps the last cost estimate when finishing without a measured cost', () => {
        const instance = tracker({ estimatedOutputCostPerMillion: 15 });
        feed(instance, 'a'.repeat(300), 400);
        const estimatedCost = lastPayload().estimatedCostMicros;

        instance.finish({ outputTokens: 999, costMicros: null });

        // 成本要等落库才算得准，但不应把流式期间的估算清空
        expect(estimatedCost).not.toBeNull();
        expect(lastPayload().estimatedCostMicros).toBe(estimatedCost);
    });

    it('prefers a measured cost over the estimate when one is given', () => {
        const instance = tracker({ estimatedOutputCostPerMillion: 15 });
        feed(instance, 'a'.repeat(300), 400);

        instance.finish({ outputTokens: 999, costMicros: 42 });

        expect(lastPayload().estimatedCostMicros).toBe(42);
    });

    it('ignores deltas after finishing', () => {
        const instance = tracker();
        feed(instance, 'a'.repeat(100), 400);
        instance.finish({ outputTokens: 10, costMicros: null });

        const callsAfterFinish = emitMock.mock.calls.length;
        feed(instance, 'a'.repeat(100), 400);

        expect(emitMock).toHaveBeenCalledTimes(callsAfterFinish);
    });

    it('stops without rewriting numbers when the run fails', () => {
        const instance = tracker();
        feed(instance, 'a'.repeat(300), 400);
        const estimated = lastPayload().outputTokens;

        instance.stop();

        const final = lastPayload();
        // 失败时拿不到供应商的实测值，保留估算比报 0 诚实
        expect(final.outputTokens).toBe(estimated);
        expect(final.streaming).toBe(false);
    });

    it('does not stop twice', () => {
        const instance = tracker();
        feed(instance, 'a'.repeat(100), 400);
        instance.stop();
        const count = emitMock.mock.calls.length;

        instance.stop();

        expect(emitMock).toHaveBeenCalledTimes(count);
    });
});
