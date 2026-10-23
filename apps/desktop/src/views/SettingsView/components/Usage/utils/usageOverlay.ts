// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type {
    UsageBucket,
    UsageLiveTurn,
    UsageSummary,
    UsageTrendPoint,
} from '@database/queries/usageStats';
import type { SessionTaskUsageProgressEvent } from '@services/EventService';

/** Default bucket widths, used only when the caller has no real width. */
function bucketMsOf(bucket: UsageBucket): number {
    if (bucket === 'minute') return 10 * 60_000;
    if (bucket === 'hour') return 3_600_000;
    return 86_400_000;
}

/**
 * Align a timestamp to its bucket start.
 *
 * Alignment must use the real bucket width and absolute (epoch) time, matching
 * the SQL `strftime('%s') / bucketSeconds` exactly. Rounding by local minute
 * would drift by whole buckets under a non-hour timezone offset.
 */
function floorToBucket(date: Date, bucket: UsageBucket, bucketMs?: number): void {
    if (!bucketMs) {
        if (bucket === 'minute') {
            date.setSeconds(0, 0);
            date.setMinutes(Math.floor(date.getMinutes() / 10) * 10);
            return;
        }
        if (bucket === 'hour') {
            date.setMinutes(0, 0, 0);
            return;
        }
        date.setHours(0, 0, 0, 0);
        return;
    }

    const ms = date.getTime();
    date.setTime(Math.floor(ms / bucketMs) * bucketMs);
}

export interface UsageCurvePoint {
    key: string;
    /** Real timestamp in ms; the x axis follows it instead of array position. */
    at: number;
    value: number;
    live: boolean;
}

/** One live sample: the instantaneous rate the tracker computed at that moment. */
export interface LiveUsageSample {
    atMs: number;
    tokens: number;
    /** Tracker sliding-window speed; older samples may lack it. */
    speed?: number;
}

export function parseUsageTime(value: string): number {
    return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

/**
 * Bucket key for a timestamp.
 *
 * With a real bucket width the timestamp is aligned first, then formatted.
 * Keys are UTC text so they match the query layer's `formatBucketKey` and
 * `parseUsageTime` can read them back.
 */
export function localUsageKey(
    date: Date,
    bucket: UsageBucket = 'day',
    /** Real bucket width; when given, align by it to match the query layer. */
    bucketMs?: number
): string {
    /*
     * Align to the bucket start first, then format. Output is UTC text, the
     * same shape as the query layer's `formatBucketKey`; `parseUsageTime`
     * appends 'Z', so both sides must be UTC to line up.
     */
    if (bucketMs && bucket !== 'day') {
        const aligned = new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
        return localUsageKey(aligned, bucket);
    }

    const day = [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
    ].join('-');
    if (bucket === 'day') return day;
    const hour = `${day} ${String(date.getUTCHours()).padStart(2, '0')}:`;
    if (bucket === 'hour') return `${hour}00`;
    return `${hour}${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Turns inside the current filter that have not settled yet.
 * A database terminal status wins over a late progress event.
 */
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

/**
 * Overlay the not-yet-persisted deltas on the historical summary.
 * The summary already covers requests, sessions, and active days.
 */
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
        // Live estimation covers output only. Scale by the unpersisted share
        // so already-priced calls are not counted twice.
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
 * Live window length.
 *
 * Across a whole range such as "today" a 30-second conversation occupies
 * 0.003% of the width and the curve looks permanently flat, so a live stream
 * switches to a sliding window that lets the increment fill the plot.
 *
 * Fifteen seconds: within a minute there are only one or two cold-start
 * spikes and long flat stretches that read as "stuck"; at this width every
 * fluctuation is visible.
 */
export const LIVE_WINDOW_MS = 15_000;

/**
 * Live curve: tokens **per second**, not a cumulative total.
 *
 * Uses the tracker's own instantaneous speed (it keeps a 5-second sliding
 * window). Do not diff the cumulative tokens instead: the tracker pushes every
 * 300ms so a fixed tick often samples the same value and yields 0, and the
 * final measured usage replaces the estimate, producing one huge jump.
 */
export function buildLiveCurve(
    samples: readonly LiveUsageSample[],
    windowMs = LIVE_WINDOW_MS,
    nowMs = Date.now()
): UsageCurvePoint[] {
    if (samples.length === 0) return [];

    const cutoff = nowMs - windowMs;
    const first = samples[0]!;
    // Right-align the window to the first sample so a fresh stream is not blank.
    const start = Math.max(cutoff, first.atMs);
    const points: UsageCurvePoint[] = [];

    for (const sample of samples) {
        if (sample.atMs < start) continue;
        const at = Math.min(sample.atMs, nowMs);
        const last = points[points.length - 1];
        if (last && at <= last.at) continue;
        points.push({ key: '', at, value: Math.max(0, sample.speed ?? 0), live: true });
    }

    const last = points[points.length - 1];
    if (!last) return points;

    /*
     * Extend the tail to the present.
     *
     * Hold the last known speed rather than dropping to 0: the tracker only
     * pushes when tokens actually arrive, so gaps over 200ms are normal, and
     * filling them with 0 makes the curve jump up from zero every few hundred
     * milliseconds. Fall to 0 only when a whole window has passed with no
     * sample, which means the stream really stopped.
     */
    if (nowMs - last.at > 200) {
        const silent = nowMs - last.at > windowMs;
        points.push({
            key: '',
            at: nowMs,
            value: silent ? 0 : last.value,
            live: true,
        });
    }

    return points;
}

/**
 * Historical curve: one point per bucket, positioned by its real start time.
 * The current bucket also carries the live samples so the tail grows to the
 * right while a conversation is running.
 */
export function buildUsageCurve(
    history: readonly UsageTrendPoint[],
    bucket: UsageBucket,
    range: { preset: string; from: string; to: string },
    turns: readonly UsageLiveTurn[],
    streams: readonly SessionTaskUsageProgressEvent[],
    liveSamples: readonly LiveUsageSample[] = [],
    nowMs = Date.now(),
    /** Real bucket width in ms; without it the width is guessed from the kind. */
    bucketMsOverride?: number
): UsageCurvePoint[] {
    const persisted = new Map(history.map((point) => [point.key, point.tokens]));
    const liveDelta = new Map<string, number>();

    for (const { turn, stream } of pendingUsageStreams(turns, streams)) {
        const key = localUsageKey(
            new Date(parseUsageTime(turn.createdAt)),
            bucket,
            bucketMsOverride
        );
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

    const bucketMs = bucketMsOverride ?? bucketMsOf(bucket);
    const start = new Date(
        range.preset === 'all' && history[0] ? atOf(history[0].key) : parseUsageTime(range.from)
    );
    const end = new Date(range.preset === 'all' ? nowMs : parseUsageTime(range.to));

    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return sparse();
    floorToBucket(start, bucket, bucketMsOverride);

    // A very long "all time" range is not padded bucket by bucket.
    if ((end.getTime() - start.getTime()) / bucketMs > 5000) return sparse();

    const points: UsageCurvePoint[] = [];
    const cursor = new Date(start);
    while (cursor.getTime() <= end.getTime()) {
        const key = localUsageKey(cursor, bucket, bucketMsOverride);
        points.push({ key, at: cursor.getTime(), value: valueOf(key), live: false });
        cursor.setTime(cursor.getTime() + bucketMs);
    }

    // Current bucket: append live samples after the bucket start so the tail
    // advances with real time.
    const currentKey = localUsageKey(new Date(nowMs), bucket, bucketMsOverride);
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
