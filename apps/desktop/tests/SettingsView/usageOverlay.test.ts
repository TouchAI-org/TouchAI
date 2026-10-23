// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { UsageLiveTurn, UsageSummary, UsageTrendPoint } from '@database/queries/usageStats';
import type { SessionTaskUsageProgressEvent } from '@services/EventService';
import { describe, expect, it } from 'vitest';

import {
    buildLiveCurve,
    buildUsageCurve,
    mergeLiveUsage,
} from '@/views/SettingsView/components/Usage/utils/usageOverlay';

const summary: UsageSummary = {
    requestCount: 3,
    sessionCount: 2,
    activeDayCount: 1,
    totalDurationMs: 1000,
    firstRequestAt: '2026-05-01 10:00:00',
    successCount: 2,
    totalCostMicros: 100,
    unpricedCount: 0,
    inputTokens: 20,
    outputTokens: 100,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    realTotalTokens: 200,
    cacheHitRate: 0.8,
    successRate: 2 / 3,
    meanTtftMs: 10,
    meanFirstTextMs: 20,
    meanDurationMs: 1000,
    decodeSpeed: 100,
};
const baseline: UsageLiveTurn = {
    taskId: 'a',
    createdAt: '2026-05-01 10:00:00',
    status: 'streaming',
    outputTokens: 100,
    totalCostMicros: 100,
    durationMs: 1000,
};
const live: SessionTaskUsageProgressEvent = {
    taskId: 'a',
    sessionId: 1,
    modelName: 'model',
    outputTokens: 150,
    tokensPerSecond: 20,
    elapsedMs: 2000,
    ttftMs: 10,
    estimatedCostMicros: 300,
    streaming: true,
};

describe('usage live overlay reconciliation', () => {
    it('adds only unpersisted output and duration without counting the request/session twice', () => {
        const result = mergeLiveUsage(summary, [baseline], [live]);
        expect(result.requestCount).toBe(3);
        expect(result.sessionCount).toBe(2);
        expect(result.activeDayCount).toBe(1);
        expect(result.outputTokens).toBe(150);
        expect(result.realTotalTokens).toBe(250);
        expect(result.totalDurationMs).toBe(2000);
        expect(result.totalCostMicros).toBe(200);
    });

    it('ignores events whose tasks do not match the database filter', () => {
        expect(mergeLiveUsage(summary, [], [live])).toEqual(summary);
    });

    it('stops overlaying terminal rows even when a late streaming event arrives', () => {
        const finished = { ...baseline, status: 'completed' };
        expect(mergeLiveUsage(summary, [finished], [live])).toEqual(summary);
        expect(mergeLiveUsage(summary, [finished], [])).toEqual(summary);
    });

    it('reconciles two concurrent tasks independently as one finishes', () => {
        const second = { ...baseline, taskId: 'b', outputTokens: 0, durationMs: null };
        const otherLive = { ...live, taskId: 'b', outputTokens: 40, estimatedCostMicros: null };
        const result = mergeLiveUsage(
            summary,
            [{ ...baseline, status: 'completed' }, second],
            [live, otherLive]
        );
        expect(result.realTotalTokens).toBe(240);
        expect(result.totalDurationMs).toBe(3000);
        expect(result.unpricedCount).toBe(1);
        expect(result.requestCount).toBe(3);
    });
});

describe('usage curve with stable historical buckets', () => {
    const points: UsageTrendPoint[] = [
        { key: '2026-05-01', tokens: 200, requests: 3, costMicros: 100, segments: [] },
    ];
    const range = { preset: 'custom', from: '2026-05-01 00:00:00', to: '2026-05-03 23:59:59' };

    it('updates the existing day bucket instead of appending differently sized time intervals', () => {
        const history = buildUsageCurve(points, 'day', range, [], []);
        const current = buildUsageCurve(points, 'day', range, [baseline], [live]);
        expect(current.map((point) => point.key)).toEqual(history.map((point) => point.key));
        expect(current.find((point) => point.key === '2026-05-01')?.value).toBe(250);
        expect(current.find((point) => point.key === '2026-05-02')?.value).toBe(0);
    });

    it('extends the live tail along real time instead of stacking on one x', () => {
        // 区间是 UTC 字符串，now 也用 UTC 构造，避免测试受本机时区影响
        const now = Date.parse('2026-05-01T10:30:00Z');
        const hourRange = {
            preset: 'custom',
            from: '2026-05-01 08:00:00',
            to: '2026-05-01 11:00:00',
        };
        const withTail = buildUsageCurve(
            points,
            'hour',
            hourRange,
            [baseline],
            [live],
            [
                { atMs: now - 40_000, tokens: 20 },
                { atMs: now - 20_000, tokens: 45 },
                { atMs: now, tokens: 80 },
            ],
            now
        );

        const livePoints = withTail.filter((point) => point.live);
        expect(livePoints).toHaveLength(3);
        // 每个采样点的 x 时间递增，曲线才能往右延伸
        expect(livePoints[1]!.at).toBeGreaterThan(livePoints[0]!.at);
        expect(livePoints[2]!.at).toBeGreaterThan(livePoints[1]!.at);
        expect(livePoints[2]!.value).toBeGreaterThan(livePoints[0]!.value);
    });

    it('reports the live rate per second rather than a running total', () => {
        const now = Date.parse('2026-05-01T10:30:00Z');
        const rate = buildLiveCurve(
            [
                { atMs: now - 30_000, tokens: 100, speed: 10 },
                { atMs: now - 20_000, tokens: 200, speed: 10 },
                { atMs: now - 10_000, tokens: 300, speed: 10 },
                { atMs: now, tokens: 400, speed: 10 },
            ],
            60_000,
            now
        );

        // 直接使用采集器给的速率；末个点是为延伸横轴补的归零点，不参与断言
        for (const point of rate.slice(0, -1)) {
            expect(point.value).toBeCloseTo(10, 5);
        }
    });

    it('holds the last known speed instead of sawtoothing to zero', () => {
        // The tracker pushes only when tokens arrive, and gaps over 200ms are
        // normal. Holding the last value avoids a jump up from zero each gap.
        const now = Date.parse('2026-05-01T10:30:00Z');
        const rate = buildLiveCurve(
            [
                { atMs: now - 1000, tokens: 100, speed: 12 },
                { atMs: now - 300, tokens: 200, speed: 40 },
            ],
            60_000,
            now
        );

        expect(rate[rate.length - 1]!.value).toBe(40);
    });

    it('drops points older than the window instead of drawing them', () => {
        const now = Date.parse('2026-05-01T10:30:00Z');
        const rate = buildLiveCurve(
            [
                { atMs: now - 40_000, tokens: 100, speed: 12 },
                { atMs: now - 30_000, tokens: 200, speed: 12 },
            ],
            15_000,
            now
        );

        // Samples outside the window are not drawn; the curve falls back to the baseline.
        expect(rate).toEqual([]);
    });

    it('does not double-count after persistence catches up', () => {
        const current = buildUsageCurve(
            points,
            'day',
            range,
            [{ ...baseline, status: 'completed' }],
            [live]
        );
        expect(current.find((point) => point.key === '2026-05-01')?.value).toBe(200);
    });
});
