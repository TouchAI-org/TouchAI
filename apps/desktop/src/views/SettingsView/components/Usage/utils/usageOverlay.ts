// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type {
    UsageBucket,
    UsageLiveTurn,
    UsageSummary,
    UsageTrendPoint,
} from '@database/queries/usageStats';
import type { SessionTaskUsageProgressEvent } from '@services/EventService';

/** 分钟桶宽度，与查询层的 5 分钟粒度一致 */
const MINUTE_BUCKET_MS = 5 * 60_000;

/** 各粒度的桶宽 */
function bucketMsOf(bucket: UsageBucket): number {
    if (bucket === 'minute') return MINUTE_BUCKET_MS;
    if (bucket === 'hour') return 3_600_000;
    return 86_400_000;
}

/** 把时间对齐到桶起点 */
function floorToBucket(date: Date, bucket: UsageBucket): void {
    if (bucket === 'minute') {
        date.setSeconds(0, 0);
        date.setMinutes(Math.floor(date.getMinutes() / 5) * 5);
        return;
    }
    if (bucket === 'hour') {
        date.setMinutes(0, 0, 0);
        return;
    }
    date.setHours(0, 0, 0, 0);
}

export interface UsageCurvePoint {
    key: string;
    /** 该点的真实时间戳（毫秒）；横轴按它定位，而不是按数组下标等距排开 */
    at: number;
    value: number;
    live: boolean;
}

/** 实时采样：某时刻本轮的累计增量 token */
export interface LiveUsageSample {
    atMs: number;
    tokens: number;
}

export function parseUsageTime(value: string): number {
    return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

export function localUsageKey(date: Date, bucket: UsageBucket = 'day'): string {
    const day = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
    ].join('-');
    if (bucket === 'day') return day;
    const hour = `${day} ${String(date.getHours()).padStart(2, '0')}:`;
    if (bucket === 'hour') return `${hour}00`;
    return `${hour}${String(Math.floor(date.getMinutes() / 5) * 5).padStart(2, '0')}`;
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

/**
 * 实时窗口长度。
 *
 * 横轴若按整个区间（如「今天」= 24 小时）铺开，一段 30 秒的对话只占宽度的
 * 万分之三，曲线看上去永远是平的。所以有流时改用滑动窗口，让增量占满宽度。
 */
export const LIVE_WINDOW_MS = 60_000;

/**
 * 实时曲线：当前这轮（或几轮并行）的累计输出 token 随时间变化。
 *
 * 与历史不同，这里直接用采样点定位，不四舍五入到桶：
 * 窗口只有一分钟，桶粒度会把曲线磨成阶梯。
 */
export function buildLiveCurve(
    samples: readonly LiveUsageSample[],
    windowMs = LIVE_WINDOW_MS,
    nowMs = Date.now()
): UsageCurvePoint[] {
    if (samples.length === 0) return [];

    const cutoff = nowMs - windowMs;
    const first = samples[0]!;
    // 对话刚开始时窗口向右对齐到采样起点，避免左边全是空白
    const start = Math.max(cutoff, first.atMs);
    const points: UsageCurvePoint[] = [];

    for (const sample of samples) {
        if (sample.atMs < start) continue;
        const at = Math.min(sample.atMs, nowMs);
        const previous = points[points.length - 1];
        if (previous && at <= previous.at) continue;
        points.push({ key: '', at, value: sample.tokens, live: true });
    }

    // 保证尾部一直延伸到现在：即使没有新 token，横轴也在走
    const last = points[points.length - 1];
    if (!last || nowMs - last.at > 200) {
        points.push({ key: '', at: nowMs, value: last?.value ?? 0, live: true });
    }

    return points;
}

/**
 * 同一时间桶内更新实时增量；横轴始终采用真实时间。
 *
 * 历史点每个桶一个（按桶起点定位）。当前桶额外附上实时采样，
 * 这样对话进行时曲线尾会真的往右长，而不是只在同一个 x 上抬高。
 */
export function buildUsageCurve(
    history: readonly UsageTrendPoint[],
    bucket: UsageBucket,
    range: { preset: string; from: string; to: string },
    turns: readonly UsageLiveTurn[],
    streams: readonly SessionTaskUsageProgressEvent[],
    liveSamples: readonly LiveUsageSample[] = [],
    nowMs = Date.now()
): UsageCurvePoint[] {
    const persisted = new Map(history.map((point) => [point.key, point.tokens]));
    const liveDelta = new Map<string, number>();

    for (const { turn, stream } of pendingUsageStreams(turns, streams)) {
        const key = localUsageKey(new Date(parseUsageTime(turn.createdAt)), bucket);
        liveDelta.set(
            key,
            (liveDelta.get(key) ?? 0) + Math.max(0, stream.outputTokens - turn.outputTokens)
        );
    }

    const valueOf = (key: string) => (persisted.get(key) ?? 0) + (liveDelta.get(key) ?? 0);
    const atOf = (key: string) => parseUsageTime(key.length > 10 ? `${key}:00` : `${key} 00:00:00`);
    const sparse = () =>
        [...new Set([...persisted.keys(), ...liveDelta.keys()])]
            .sort()
            .map((key) => ({ key, at: atOf(key), value: valueOf(key), live: false }));

    const bucketMs = bucketMsOf(bucket);
    const start = new Date(
        range.preset === 'all' && history[0] ? atOf(history[0].key) : parseUsageTime(range.from)
    );
    const end = new Date(range.preset === 'all' ? nowMs : parseUsageTime(range.to));

    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return sparse();
    floorToBucket(start, bucket);

    // 极长的「全部」范围不逐桶铺满，只保留有数据的桶
    if ((end.getTime() - start.getTime()) / bucketMs > 5000) return sparse();

    const points: UsageCurvePoint[] = [];
    const cursor = new Date(start);
    while (cursor.getTime() <= end.getTime()) {
        const key = localUsageKey(cursor, bucket);
        points.push({ key, at: cursor.getTime(), value: valueOf(key), live: false });
        cursor.setTime(cursor.getTime() + bucketMs);
    }

    // 当前桶：把实时采样按真实时间接在桶起点之后，尾部会随时间往右走
    const currentKey = localUsageKey(new Date(nowMs), bucket);
    const currentIndex = points.findIndex((point) => point.key === currentKey);
    if (currentIndex >= 0 && liveSamples.length > 0) {
        const bucketStartAt = points[currentIndex]!.at;
        const base = persisted.get(currentKey) ?? 0;
        const tail: UsageCurvePoint[] = [];
        for (const sample of liveSamples) {
            const at = Math.max(bucketStartAt + 1, Math.min(sample.atMs, nowMs));
            const previous = tail[tail.length - 1];
            if (previous && at <= previous.at) continue;
            tail.push({ key: currentKey, at, value: base + sample.tokens, live: true });
        }
        if (tail.length > 0) points.splice(currentIndex + 1, 0, ...tail);
    }

    return points;
}
