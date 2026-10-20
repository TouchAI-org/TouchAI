// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { UsageLiveTurn, UsageSummary, UsageTrendPoint } from '@database/queries/usageStats';
import type { SessionTaskUsageProgressEvent } from '@services/EventService';

export interface UsageCurvePoint {
    key: string;
    value: number;
    live: boolean;
}

export function parseUsageTime(value: string): number {
    return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

export function localUsageKey(date: Date, bucket: 'hour' | 'day' = 'day'): string {
    const day = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
    ].join('-');
    return bucket === 'hour' ? `${day} ${String(date.getHours()).padStart(2, '0')}:00` : day;
}

/** 只使用当前筛选内尚未终结的任务。数据库终态优先于迟到的进度事件。 */
export function pendingUsageStreams(
    turns: readonly UsageLiveTurn[],
    streams: readonly SessionTaskUsageProgressEvent[]
): Array<{ turn: UsageLiveTurn; stream: SessionTaskUsageProgressEvent }> {
    const byTask = new Map(streams.map((stream) => [stream.taskId, stream]));
    return turns.flatMap((turn) => {
        if (turn.status !== 'streaming' && turn.status !== 'pending') return [];
        const stream = byTask.get(turn.taskId);
        return stream ? [{ turn, stream }] : [];
    });
}

/** 历史汇总已包含请求、会话与活跃日；只叠加各任务尚未落库的增量。 */
export function mergeLiveUsage(
    summary: UsageSummary,
    turns: readonly UsageLiveTurn[],
    streams: readonly SessionTaskUsageProgressEvent[]
): UsageSummary {
    const merged = { ...summary };
    for (const { turn, stream } of pendingUsageStreams(turns, streams)) {
        const outputDelta = Math.max(0, stream.outputTokens - turn.outputTokens);
        merged.outputTokens += outputDelta;
        merged.realTotalTokens += outputDelta;
        merged.totalDurationMs += Math.max(0, stream.elapsedMs - (turn.durationMs ?? 0));
        // 实时估算只覆盖输出。只按尚未落库输出的比例叠加，避免重复计算已计价调用。
        if (outputDelta > 0) {
            if (stream.estimatedCostMicros === null) {
                merged.unpricedCount += 1;
            } else {
                merged.totalCostMicros += Math.round(
                    (stream.estimatedCostMicros * outputDelta) / Math.max(1, stream.outputTokens)
                );
            }
        }
    }
    return merged;
}

/** 同一小时/日桶内更新实时增量；横轴始终采用真实时间，不拼接半秒采样点。 */
export function buildUsageCurve(
    history: readonly UsageTrendPoint[],
    bucket: 'hour' | 'day',
    range: { preset: string; from: string; to: string },
    turns: readonly UsageLiveTurn[],
    streams: readonly SessionTaskUsageProgressEvent[]
): UsageCurvePoint[] {
    const values = new Map(
        history.map((point) => [point.key, { key: point.key, value: point.tokens, live: false }])
    );
    for (const { turn, stream } of pendingUsageStreams(turns, streams)) {
        const key = localUsageKey(new Date(parseUsageTime(turn.createdAt)), bucket);
        const point = values.get(key) ?? { key, value: 0, live: false };
        point.value += Math.max(0, stream.outputTokens - turn.outputTokens);
        point.live ||= stream.streaming;
        values.set(key, point);
    }

    const ordered = [...values.values()].sort((left, right) => left.key.localeCompare(right.key));
    const start = new Date(
        range.preset === 'all' && ordered[0]
            ? `${ordered[0].key.replace(' ', 'T')}${bucket === 'day' ? 'T00:00:00' : ':00'}`
            : parseUsageTime(range.from)
    );
    const end = new Date(range.preset === 'all' ? Date.now() : parseUsageTime(range.to));
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return ordered;
    if (bucket === 'hour') start.setMinutes(0, 0, 0);
    else start.setHours(0, 0, 0, 0);

    const points: UsageCurvePoint[] = [];
    // 极长的「全部」范围保留稀疏桶，绘制时仍用真实时间坐标。
    const bucketMs = bucket === 'hour' ? 3_600_000 : 86_400_000;
    if ((end.getTime() - start.getTime()) / bucketMs > 5000) return ordered;
    for (const cursor = new Date(start); cursor.getTime() <= end.getTime(); ) {
        const key = localUsageKey(cursor, bucket);
        points.push(values.get(key) ?? { key, value: 0, live: false });
        if (bucket === 'hour') cursor.setTime(cursor.getTime() + bucketMs);
        else cursor.setDate(cursor.getDate() + 1);
    }
    return points;
}
