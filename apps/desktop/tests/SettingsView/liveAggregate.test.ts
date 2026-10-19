// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { SessionTaskUsageProgressEvent } from '@services/EventService';

import {
    aggregateStreams,
    isStale,
    shouldDropFinishedStreams,
} from '../../src/views/SettingsView/components/Usage/utils/liveAggregate';

function stream(
    partial: Partial<SessionTaskUsageProgressEvent> & { taskId: string }
): SessionTaskUsageProgressEvent {
    return {
        sessionId: 1,
        modelName: 'model',
        outputTokens: 0,
        tokensPerSecond: null,
        elapsedMs: 0,
        ttftMs: null,
        estimatedCostMicros: null,
        streaming: true,
        ...partial,
    };
}

describe('aggregateStreams', () => {
    it('returns an empty snapshot for no streams', () => {
        const result = aggregateStreams([]);

        expect(result).toEqual({
            activeCount: 0,
            anyStreaming: false,
            speed: null,
            totalTokens: 0,
            totalCostMicros: null,
            elapsedMs: 0,
            ttftMs: null,
            modelNames: [],
        });
    });

    it('passes a single stream through unchanged', () => {
        const result = aggregateStreams([
            stream({
                taskId: 'a',
                modelName: 'claude-sonnet',
                outputTokens: 120,
                tokensPerSecond: 60,
                elapsedMs: 2000,
                ttftMs: 400,
                estimatedCostMicros: 15,
            }),
        ]);

        expect(result).toMatchObject({
            activeCount: 1,
            anyStreaming: true,
            speed: 60,
            totalTokens: 120,
            totalCostMicros: 15,
            elapsedMs: 2000,
            ttftMs: 400,
            modelNames: ['claude-sonnet'],
        });
    });

    it('sums speed and tokens across concurrent streams', () => {
        const result = aggregateStreams([
            stream({ taskId: 'a', outputTokens: 100, tokensPerSecond: 40, estimatedCostMicros: 5 }),
            stream({ taskId: 'b', outputTokens: 250, tokensPerSecond: 80, estimatedCostMicros: 9 }),
        ]);

        // 这正是「多路同时跑」要看到的数字：整体吞吐是各流之和
        expect(result.activeCount).toBe(2);
        expect(result.speed).toBe(120);
        expect(result.totalTokens).toBe(350);
        expect(result.totalCostMicros).toBe(14);
    });

    it('counts only streaming entries as active', () => {
        const result = aggregateStreams([
            stream({ taskId: 'a', tokensPerSecond: 40, outputTokens: 100 }),
            stream({
                taskId: 'b',
                tokensPerSecond: 80,
                outputTokens: 250,
                streaming: false,
            }),
        ]);

        expect(result.activeCount).toBe(1);
        expect(result.anyStreaming).toBe(true);
        // 结束的流速度视为 0，不应继续计入吞吐；但它的 token 仍算在合计里
        expect(result.speed).toBe(40);
        expect(result.totalTokens).toBe(350);
    });

    it('ignores entries without a measurable speed', () => {
        const result = aggregateStreams([
            stream({ taskId: 'a', tokensPerSecond: null }),
            stream({ taskId: 'b', tokensPerSecond: 30 }),
        ]);

        expect(result.speed).toBe(30);
    });

    it('reports no speed when nothing is streaming', () => {
        const result = aggregateStreams([
            stream({ taskId: 'a', tokensPerSecond: 30, streaming: false }),
        ]);

        expect(result.speed).toBeNull();
        expect(result.anyStreaming).toBe(false);
    });

    it('withholds the cost total when any stream is unpriced', () => {
        const result = aggregateStreams([
            stream({ taskId: 'a', estimatedCostMicros: 5 }),
            stream({ taskId: 'b', estimatedCostMicros: null }),
        ]);

        // 把缺失值当 0 会低估，宁可不给合计
        expect(result.totalCostMicros).toBeNull();
    });

    it('reports the longest elapsed time and the earliest first token', () => {
        const result = aggregateStreams([
            stream({ taskId: 'a', elapsedMs: 3000, ttftMs: 900 }),
            stream({ taskId: 'b', elapsedMs: 8000, ttftMs: 300 }),
        ]);

        expect(result.elapsedMs).toBe(8000);
        expect(result.ttftMs).toBe(300);
    });

    it('deduplicates model names while keeping their order', () => {
        const result = aggregateStreams([
            stream({ taskId: 'a', modelName: 'gpt-5' }),
            stream({ taskId: 'b', modelName: 'claude-sonnet' }),
            stream({ taskId: 'c', modelName: 'gpt-5' }),
        ]);

        expect(result.modelNames).toEqual(['gpt-5', 'claude-sonnet']);
    });
});

describe('shouldDropFinishedStreams', () => {
    it('drops the finished batch when a brand new stream starts', () => {
        const finished = [stream({ taskId: 'old', streaming: false })];

        expect(shouldDropFinishedStreams(finished, true)).toBe(true);
    });

    it('keeps the batch when the new stream joins running ones', () => {
        const running = [stream({ taskId: 'a', streaming: true })];

        // 有一路还在跑，可能是同一批的并行任务，不能清掉
        expect(shouldDropFinishedStreams(running, true)).toBe(false);
    });

    it('keeps the batch for updates to an already known stream', () => {
        const finished = [stream({ taskId: 'old', streaming: false })];

        expect(shouldDropFinishedStreams(finished, false)).toBe(false);
    });

    it('does nothing when there is nothing to drop', () => {
        expect(shouldDropFinishedStreams([], true)).toBe(false);
    });
});

describe('isStale', () => {
    it('never treats a running stream as stale', () => {
        expect(isStale(stream({ taskId: 'a', streaming: true }), 0, 999_999, 1000)).toBe(false);
    });

    it('keeps a finished stream during the linger window', () => {
        expect(isStale(stream({ taskId: 'a', streaming: false }), 1000, 1500, 1000)).toBe(false);
    });

    it('drops a finished stream once the linger window passes', () => {
        expect(isStale(stream({ taskId: 'a', streaming: false }), 1000, 2000, 1000)).toBe(true);
    });
});
