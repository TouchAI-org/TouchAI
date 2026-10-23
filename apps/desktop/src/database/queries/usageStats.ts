// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { and, between, count, desc, eq, inArray, like, or, type SQL, sql } from 'drizzle-orm';

import { estimateTokensFromChars } from '@/utils/promptBreakdown';

import { type DatabaseExecutor, db } from '../index';
import {
    messageParts,
    models,
    providers,
    sessions,
    sessionTurns,
    usageDailyRollups,
} from '../schema';

// ============================================================================
// Types
// ============================================================================

export type UsageRangePreset = 'today' | '24h' | '7d' | '30d' | 'all' | 'custom';

export interface UsageFilter {
    /** ISO datetime string. */
    from: string;
    /** ISO datetime string. */
    to: string;
    modelIds?: number[];
    providerIds?: number[];
    statuses?: Array<'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled'>;
    onlyFailed?: boolean;
    onlyRetried?: boolean;
    search?: string;
}

export interface UsageSummary {
    /** Turn count. */
    requestCount: number;
    /** Sessions that produced usage. */
    sessionCount: number;
    /** Active days: calendar days with at least one turn. */
    activeDayCount: number;
    /** Sum of turn durations in ms; not the first-to-last span. */
    totalDurationMs: number;
    /** UTC time of the first matching request, used for mean RPM over all time. */
    firstRequestAt: string | null;
    successCount: number;
    totalCostMicros: number;
    unpricedCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    /** Fresh input + output + cache read + cache write. */
    realTotalTokens: number;
    /** cacheRead / (input + cacheWrite + cacheRead) */
    cacheHitRate: number;
    successRate: number;
    meanTtftMs: number | null;
    /** Mean first-text latency (first content, excluding reasoning); null without samples. */
    meanFirstTextMs: number | null;
    meanDurationMs: number | null;
    /** Mean decode speed in tok/s; null without enough samples. */
    decodeSpeed: number | null;
}

/** Task baseline from the same snapshot as the summary, used to subtract persisted live usage. */
export interface UsageLiveTurn {
    taskId: string;
    createdAt: string;
    status: string;
    outputTokens: number;
    totalCostMicros: number;
    durationMs: number | null;
}

/**
 * Trend bucket granularity.
 *
 * A short range needs minute buckets, otherwise looking at "today" just after
 * midnight yields two or three hour buckets and one spike; a long range needs
 *
 * day buckets, otherwise there are too many points to draw. The width is
 * derived from the span and snapped to whole-minute steps (1/2/5/10/15/30 min,
 * 1/2/3/6/12 h, 1 day): an hour shows 2-minute buckets, six hours 10-minute,
 * a week 6-hour, a month 1-day, keeping the point count in a readable band.
 */
export type UsageBucket = 'minute' | 'hour' | 'day';

/** Milliseconds per hour, used when deriving the bucket width. */
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Target point count; this density reads well on the curve. */
export const USAGE_TARGET_BUCKETS = 48;

/** Allowed bucket widths in ms. */
const BUCKET_STEPS = [
    60_000,
    2 * 60_000,
    5 * 60_000,
    10 * 60_000,
    15 * 60_000,
    30 * 60_000,
    HOUR_MS,
    2 * HOUR_MS,
    3 * HOUR_MS,
    6 * HOUR_MS,
    12 * HOUR_MS,
    DAY_MS,
];

/**
 * Pick the bucket width for a range span.
 *
 * Snaps to the first step at or above span / target, so every span lands on a
 * sensible density instead of jumping from 10 minutes to an hour at a boundary.
 */
export function resolveUsageBucketMs(spanMs: number): number {
    if (!(spanMs > 0)) return 10 * 60_000;

    const ideal = spanMs / USAGE_TARGET_BUCKETS;
    let best = BUCKET_STEPS[0]!;
    for (const step of BUCKET_STEPS) {
        // First step at or above the ideal; beyond the largest step it caps there.
        best = step;
        if (step >= ideal) break;
    }
    return best;
}

/** Bucket width to granularity name, so the UI can pick alignment and labels. */
export function bucketKindOf(bucketMs: number): UsageBucket {
    if (bucketMs >= DAY_MS) return 'day';
    if (bucketMs >= HOUR_MS) return 'hour';
    return 'minute';
}

/** Granularity for a span; kept for older call sites. */
export function resolveUsageBucket(spanMs: number): UsageBucket {
    return bucketKindOf(resolveUsageBucketMs(spanMs));
}
export interface UsageTrendSegment {
    /** Group id; null when the group no longer exists. */
    groupId: number | null;
    name: string;
    requests: number;
    tokens: number;
    costMicros: number;
}

export interface UsageTrendPoint {
    key: string;
    requests: number;
    tokens: number;
    costMicros: number;
    /** Stack segments sorted by total, so the UI can take the top N and merge the rest. */
    segments: UsageTrendSegment[];
}

/** A ranking row: a model or a session. */
export interface UsageRankItem {
    id: number;
    /** Primary label: model name or session title. */
    name: string;
    /** Secondary line for session rows (model name); empty for model rows. */
    subtitle: string | null;
    /** Last active time, for session rows. */
    lastAt: string | null;
    requests: number;
    tokens: number;
    costMicros: number;
    unpricedCount: number;
    /** Session duration in ms; null for model rows. */
    durationMs: number | null;
}

/** Ranking metric, matching the three-way switch in the UI. */
export type UsageRankMetric = 'tokens' | 'cost' | 'duration';

/**
 * One slice of a composition ring.
 *
 * When `estimated` is true the value came from character counts and the UI
 * must mark it with ≈; output tokens and timings are measured and exact.
 */
export interface UsageCompositionSegment {
    key: string;
    value: number;
    estimated: boolean;
}

/** Composition: tokens show what the context held, timings show where time went. */
export interface UsageComposition {
    tokens: { total: number; segments: UsageCompositionSegment[] };
    timing: { totalMs: number; segments: UsageCompositionSegment[] };
    /** Cache read as a share of billed input; a footnote, not a slice. */
    cacheReadShare: number;
}

/** Tool call stats derived from `tool_call` parts. */
export interface ToolUsageStat {
    /** Tool name, e.g. `builtin__read` or `mcp__server__tool`. */
    name: string;
    kind: 'builtin' | 'mcp';
    count: number;
    errorCount: number;
    /** Mean duration; null without samples. */
    meanDurationMs: number | null;
}

export interface ToolUsageSummary {
    totalCount: number;
    errorCount: number;
    /** Distinct tools used. */
    distinctTools: number;
    meanDurationMs: number | null;
    byTool: ToolUsageStat[];
}

export interface UsageGroup {
    id: number | null;
    name: string;
    requestCount: number;
    successCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalCostMicros: number;
    unpricedCount: number;
    meanTtftMs: number | null;
    meanDurationMs: number | null;
}

/**
 * One heatmap cell.
 *
 * Returned per day and hour so the component can render either: a short range
 * needs hours against dates to show density, a long range needs weekdays
 * against weeks to show a calendar. Aggregating by day here would leave a short range with one or two cells.
 */
export interface UsageHeatmapDay {
    day: string;
    /** 0-23 in local time. */
    hour: number;
    requests: number;
    tokens: number;
    costMicros: number;
}

export interface UsageFilterOptions {
    models: Array<{ id: number; name: string; count: number }>;
    providers: Array<{ id: number; name: string; count: number }>;
}

// ============================================================================
// Internal: WHERE construction
// ============================================================================

/** Turn-level WHERE shared by every aggregate so the numbers agree. */
function buildTurnWhere(filter: UsageFilter): SQL {
    const clauses: Array<SQL | undefined> = [
        between(sessionTurns.created_at, filter.from, filter.to),
    ];

    if (filter.modelIds?.length) {
        clauses.push(inArray(sessionTurns.model_id, filter.modelIds));
    }
    if (filter.providerIds?.length) {
        const providerIds = filter.providerIds;
        clauses.push(
            sql`${sessionTurns.model_id} IN (SELECT ${models.id} FROM ${models} WHERE ${models.provider_id} IN (${sql.join(
                providerIds.map((id) => sql`${id}`),
                sql`, `
            )}))`
        );
    }
    if (filter.statuses?.length) {
        clauses.push(inArray(sessionTurns.status, filter.statuses));
    }
    if (filter.onlyFailed) {
        clauses.push(eq(sessionTurns.status, 'failed'));
    }
    if (filter.onlyRetried) {
        // Retried turns: more than one attempt.
        clauses.push(
            sql`(SELECT count(*) FROM session_turn_attempts WHERE turn_id = ${sessionTurns.id}) > 1`
        );
    }
    if (filter.search?.trim()) {
        const pattern = `%${filter.search.trim()}%`;
        clauses.push(
            or(
                like(sessionTurns.error_message, pattern),
                sql`${sessionTurns.model_id} IN (
                    SELECT ${models.id} FROM ${models}
                    INNER JOIN ${providers} ON ${providers.id} = ${models.provider_id}
                    WHERE ${models.name} LIKE ${pattern}
                       OR ${models.model_id} LIKE ${pattern}
                       OR ${providers.name} LIKE ${pattern}
                )`
            )!
        );
    }

    return and(...clauses)!;
}

/** Cache hit rate: cacheRead / (input + cacheWrite + cacheRead). */
function computeCacheHitRate(input: number, cacheRead: number, cacheWrite: number): number {
    const denominator = input + cacheWrite + cacheRead;
    return denominator > 0 ? cacheRead / denominator : 0;
}

// ============================================================================
// Summary
// ============================================================================

export const getUsageSummary = async (
    filter: UsageFilter,
    database: DatabaseExecutor = db
): Promise<UsageSummary> => {
    const row = await database
        .select({
            requestCount: count(),
            successCount: sql<number>`sum(case when ${sessionTurns.status} = 'completed' then 1 else 0 end)`,
            totalCostMicros: sql<number>`coalesce(sum(${sessionTurns.total_cost_micros}), 0)`,
            unpricedCount: sql<number>`coalesce(sum(${sessionTurns.unpriced_calls}), 0)`,
            inputTokens: sql<number>`coalesce(sum(${sessionTurns.input_tokens}), 0)`,
            outputTokens: sql<number>`coalesce(sum(${sessionTurns.output_tokens}), 0)`,
            cacheReadTokens: sql<number>`coalesce(sum(${sessionTurns.cache_read_tokens}), 0)`,
            cacheWriteTokens: sql<number>`coalesce(sum(${sessionTurns.cache_write_tokens}), 0)`,
            reasoningTokens: sql<number>`coalesce(sum(${sessionTurns.reasoning_tokens}), 0)`,
            sumTtft: sql<number>`coalesce(sum(${sessionTurns.ttft_ms}), 0)`,
            ttftCount: sql<number>`count(${sessionTurns.ttft_ms})`,
            sumFirstText: sql<number>`coalesce(sum(${sessionTurns.first_text_ms}), 0)`,
            firstTextCount: sql<number>`count(${sessionTurns.first_text_ms})`,
            sumDuration: sql<number>`coalesce(sum(${sessionTurns.duration_ms}), 0)`,
            durationCount: sql<number>`count(${sessionTurns.duration_ms})`,
            sessionCount: sql<number>`count(distinct ${sessionTurns.session_id})`,
            activeDayCount: sql<number>`count(distinct date(${sessionTurns.created_at}, 'localtime'))`,
            firstRequestAt: sql<string | null>`min(${sessionTurns.created_at})`,
        })
        .from(sessionTurns)
        .where(buildTurnWhere(filter))
        .get();

    const requestCount = row?.requestCount ?? 0;
    const successCount = row?.successCount ?? 0;
    const inputTokens = row?.inputTokens ?? 0;
    const outputTokens = row?.outputTokens ?? 0;
    const cacheReadTokens = row?.cacheReadTokens ?? 0;
    const cacheWriteTokens = row?.cacheWriteTokens ?? 0;
    const ttftCount = row?.ttftCount ?? 0;
    const durationCount = row?.durationCount ?? 0;
    const meanDurationMs =
        durationCount > 0 ? Math.round((row?.sumDuration ?? 0) / durationCount) : null;
    const meanTtftMs = ttftCount > 0 ? Math.round((row?.sumTtft ?? 0) / ttftCount) : null;
    const firstTextCount = row?.firstTextCount ?? 0;
    const meanFirstTextMs =
        firstTextCount > 0 ? Math.round((row?.sumFirstText ?? 0) / firstTextCount) : null;

    return {
        requestCount,
        sessionCount: row?.sessionCount ?? 0,
        activeDayCount: row?.activeDayCount ?? 0,
        // Active duration is the sum of turn durations, not the first-to-last span:
        // the latter would count idle hours in between and hide real conversation intensity.
        totalDurationMs: row?.sumDuration ?? 0,
        firstRequestAt: row?.firstRequestAt ?? null,
        successCount,
        totalCostMicros: row?.totalCostMicros ?? 0,
        unpricedCount: row?.unpricedCount ?? 0,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens: row?.reasoningTokens ?? 0,
        realTotalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        cacheHitRate: computeCacheHitRate(inputTokens, cacheReadTokens, cacheWriteTokens),
        successRate: requestCount > 0 ? successCount / requestCount : 0,
        meanTtftMs,
        meanFirstTextMs,
        meanDurationMs,
        // Rough decode speed: output tokens / total duration. An exact value needs
        // flowMs, which turns do not carry; the UI marks it with ≈.
        decodeSpeed:
            meanDurationMs !== null && outputTokens > 0
                ? outputTokens / requestCount / (meanDurationMs / 1000)
                : null,
    };
};

/** Summary and task baseline must share one read snapshot so a completion write cannot slip between them. */
export const getUsageDashboardSnapshot = async (
    filter: UsageFilter,
    taskIds: string[],
    dimension: 'model' | 'provider' = 'model'
): Promise<{
    summary: UsageSummary;
    liveTurns: UsageLiveTurn[];
    trend: { bucket: UsageBucket; bucketMs: number; points: UsageTrendPoint[] };
}> =>
    db.transaction(
        async (tx) => {
            const summary = await getUsageSummary(filter, tx);
            const liveTurns = taskIds.length
                ? await tx
                      .select({
                          taskId: sessionTurns.task_id,
                          createdAt: sessionTurns.created_at,
                          status: sessionTurns.status,
                          outputTokens: sessionTurns.output_tokens,
                          totalCostMicros: sessionTurns.total_cost_micros,
                          durationMs: sessionTurns.duration_ms,
                      })
                      .from(sessionTurns)
                      .where(and(buildTurnWhere(filter), inArray(sessionTurns.task_id, taskIds)))
                      .all()
                : [];
            const trend = await getUsageTrend(filter, dimension, tx);
            return { summary, liveTurns, trend };
        },
        { behavior: 'deferred' }
    );

// ============================================================================
// Trend
// ============================================================================

/**
 * Trend: aggregate per time bucket and split each bucket into stack segments by
 *
 * model or provider. One query returns bucket-by-group rows that are folded
 * into buckets in memory; `dimension` matches the chart switch.
 */
export const getUsageTrend = async (
    filter: UsageFilter,
    dimension: 'model' | 'provider' = 'model',
    database: DatabaseExecutor = db
): Promise<{ bucket: UsageBucket; bucketMs: number; points: UsageTrendPoint[] }> => {
    const spanMs = new Date(filter.to).getTime() - new Date(filter.from).getTime();
    const bucketMs = resolveUsageBucketMs(spanMs);
    const bucket = bucketKindOf(bucketMs);

    /*
     * Bucket key is integer division of Unix seconds by the bucket width.
     *
     * Do **not** pass 'localtime' to strftime here: created_at holds UTC text
     * and `new Date(seconds)` already converts to local time. Converting twice
     * shifts every label by the timezone offset, putting trend keys outside the
     * queried range so the curve renders flat at zero.
     */
    const bucketSeconds = Math.max(60, Math.round(bucketMs / 1000));
    const keyExpr = sql<number>`cast(
        cast(strftime('%s', ${sessionTurns.created_at}) as integer) / ${bucketSeconds}
        as integer
    )`;

    const groupIdExpr =
        dimension === 'model'
            ? sql<number>`${models.id}`
            : sql<number>`coalesce(${providers.id}, 0)`;
    const groupNameExpr =
        dimension === 'model'
            ? sql<string>`${models.name}`
            : sql<string>`coalesce(${providers.name}, '—')`;

    const rows = await database
        .select({
            key: keyExpr.as('key'),
            groupId: groupIdExpr.as('groupId'),
            groupName: groupNameExpr.as('groupName'),
            requests: count(),
            tokens: sql<number>`coalesce(sum(
                ${sessionTurns.input_tokens} + ${sessionTurns.output_tokens}
                + ${sessionTurns.cache_read_tokens} + ${sessionTurns.cache_write_tokens}
            ), 0)`,
            costMicros: sql<number>`coalesce(sum(${sessionTurns.total_cost_micros}), 0)`,
        })
        .from(sessionTurns)
        .innerJoin(models, eq(models.id, sessionTurns.model_id))
        .leftJoin(providers, eq(providers.id, models.provider_id))
        .where(buildTurnWhere(filter))
        .groupBy(keyExpr, groupIdExpr, groupNameExpr)
        .orderBy(keyExpr)
        .all();

    // Fold into buckets; segments inside a bucket sort by tokens so the chart can take the top N.
    const byBucket = new Map<number, UsageTrendPoint>();
    for (const row of rows) {
        const bucketIndex = Number(row.key);
        let point = byBucket.get(bucketIndex);
        if (!point) {
            // Integer bucket index to a UTC label; the SQL side already floored it.
            const at = new Date(bucketIndex * bucketSeconds * 1000);
            point = {
                key: formatBucketKey(at, bucket),
                requests: 0,
                tokens: 0,
                costMicros: 0,
                segments: [],
            };
            byBucket.set(bucketIndex, point);
        }

        point.requests += row.requests;
        point.tokens += row.tokens;
        point.costMicros += row.costMicros;
        point.segments.push({
            // Provider rows use 0 for "none"; model rows keep the real id.
            groupId: row.groupId === 0 && dimension === 'provider' ? null : row.groupId,
            name: row.groupName || '—',
            requests: row.requests,
            tokens: row.tokens,
            costMicros: row.costMicros,
        });
    }

    for (const point of byBucket.values()) {
        point.segments.sort((left, right) => right.tokens - left.tokens);
    }

    return { bucket, bucketMs, points: [...byBucket.values()] };
};

/**
 * Bucket start to label.
 *
 * Labels are **UTC** text, the same basis as created_at. Consumers parse them
 * with `parseUsageTime`, which appends 'Z' to a zone-less string, so this must
 * be UTC; formatting in local time would offset every key and the curve would
 * never line up.
 */
function formatBucketKey(at: Date, bucket: UsageBucket): string {
    const day = [
        at.getUTCFullYear(),
        String(at.getUTCMonth() + 1).padStart(2, '0'),
        String(at.getUTCDate()).padStart(2, '0'),
    ].join('-');
    if (bucket === 'day') return day;

    const hour = `${day} ${String(at.getUTCHours()).padStart(2, '0')}:`;
    if (bucket === 'hour') return `${hour}00`;
    return `${hour}${String(at.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * All-time trend, read from the daily rollup table.
 *
 * Rollups are kept forever and hold only a few dozen rows, while
 * `session_turns` is emptied by turn cleanup and by retention. Answering "how
 * much has been spent overall" from the archive keeps it from dropping to zero
 * after a prune.
 *
 * Only valid without a model or provider filter: the rollup stores names rather
 * than ids and cannot take part in id-based filtering.
 */
export const getUsageTrendFromArchive = async (): Promise<{
    bucket: 'day';
    points: UsageTrendPoint[];
}> => {
    const rows = await db
        .select({
            key: usageDailyRollups.day,
            groupName: usageDailyRollups.model_name,
            requests: sql<number>`coalesce(sum(${usageDailyRollups.request_count}), 0)`,
            tokens: sql<number>`coalesce(sum(
                ${usageDailyRollups.input_tokens} + ${usageDailyRollups.output_tokens}
                + ${usageDailyRollups.cache_read_tokens} + ${usageDailyRollups.cache_write_tokens}
            ), 0)`,
            costMicros: sql<number>`coalesce(sum(${usageDailyRollups.total_cost_micros}), 0)`,
        })
        .from(usageDailyRollups)
        .groupBy(usageDailyRollups.day, usageDailyRollups.model_name)
        .orderBy(usageDailyRollups.day)
        .all();

    const byBucket = new Map<string, UsageTrendPoint>();
    for (const row of rows) {
        let point = byBucket.get(row.key);
        if (!point) {
            point = { key: row.key, requests: 0, tokens: 0, costMicros: 0, segments: [] };
            byBucket.set(row.key, point);
        }

        point.requests += row.requests;
        point.tokens += row.tokens;
        point.costMicros += row.costMicros;
        point.segments.push({
            // The archive stores names, not ids.
            groupId: null,
            name: row.groupName || '—',
            requests: row.requests,
            tokens: row.tokens,
            costMicros: row.costMicros,
        });
    }

    for (const point of byBucket.values()) {
        point.segments.sort((left, right) => right.tokens - left.tokens);
    }

    return { bucket: 'day', points: [...byBucket.values()] };
};

/** The archive cannot serve a filtered trend; it has no id dimension. */
export function canUseUsageArchive(filter: UsageFilter): boolean {
    return (
        !filter.modelIds?.length &&
        !filter.providerIds?.length &&
        !filter.statuses?.length &&
        !filter.onlyFailed &&
        !filter.onlyRetried &&
        !filter.search?.trim()
    );
}

// ============================================================================
// Rankings
// ============================================================================

function toGroup(row: {
    id: number | null;
    name: string;
    requestCount: number;
    successCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalCostMicros: number;
    unpricedCount: number;
    sumTtft: number;
    ttftCount: number;
    sumDuration: number;
    durationCount: number;
}): UsageGroup {
    return {
        id: row.id,
        name: row.name || '—',
        requestCount: row.requestCount,
        successCount: row.successCount,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        totalCostMicros: row.totalCostMicros,
        unpricedCount: row.unpricedCount,
        meanTtftMs: row.ttftCount > 0 ? Math.round(row.sumTtft / row.ttftCount) : null,
        meanDurationMs:
            row.durationCount > 0 ? Math.round(row.sumDuration / row.durationCount) : null,
    };
}

const groupSelection = {
    requestCount: count(),
    successCount: sql<number>`sum(case when ${sessionTurns.status} = 'completed' then 1 else 0 end)`,
    inputTokens: sql<number>`coalesce(sum(${sessionTurns.input_tokens}), 0)`,
    outputTokens: sql<number>`coalesce(sum(${sessionTurns.output_tokens}), 0)`,
    cacheReadTokens: sql<number>`coalesce(sum(${sessionTurns.cache_read_tokens}), 0)`,
    cacheWriteTokens: sql<number>`coalesce(sum(${sessionTurns.cache_write_tokens}), 0)`,
    totalCostMicros: sql<number>`coalesce(sum(${sessionTurns.total_cost_micros}), 0)`,
    unpricedCount: sql<number>`coalesce(sum(${sessionTurns.unpriced_calls}), 0)`,
    sumTtft: sql<number>`coalesce(sum(${sessionTurns.ttft_ms}), 0)`,
    ttftCount: sql<number>`count(${sessionTurns.ttft_ms})`,
    sumDuration: sql<number>`coalesce(sum(${sessionTurns.duration_ms}), 0)`,
    durationCount: sql<number>`count(${sessionTurns.duration_ms})`,
};

export const getUsageByModel = async (filter: UsageFilter): Promise<UsageGroup[]> => {
    const rows = await db
        .select({ id: models.id, name: models.name, ...groupSelection })
        .from(sessionTurns)
        .innerJoin(models, eq(models.id, sessionTurns.model_id))
        .where(buildTurnWhere(filter))
        .groupBy(models.id, models.name)
        .orderBy(
            desc(
                sql`coalesce(sum(${sessionTurns.input_tokens} + ${sessionTurns.output_tokens}), 0)`
            )
        )
        .all();

    return rows.map(toGroup);
};

export const getUsageByProvider = async (filter: UsageFilter): Promise<UsageGroup[]> => {
    const rows = await db
        .select({ id: providers.id, name: providers.name, ...groupSelection })
        .from(sessionTurns)
        .innerJoin(models, eq(models.id, sessionTurns.model_id))
        .innerJoin(providers, eq(providers.id, models.provider_id))
        .where(buildTurnWhere(filter))
        .groupBy(providers.id, providers.name)
        .orderBy(
            desc(
                sql`coalesce(sum(${sessionTurns.input_tokens} + ${sessionTurns.output_tokens}), 0)`
            )
        )
        .all();

    return rows.map(toGroup);
};

/**
 * Model ranking sorted by the chosen metric.
 *
 * Unlike `getUsageByModel`, which returns every field for the table, this
 * returns only what a ranking row needs, ordered by `metric`.
 */
export const getModelRanking = async (
    filter: UsageFilter,
    metric: UsageRankMetric = 'tokens',
    limit = 8
): Promise<UsageRankItem[]> => {
    const orderExpr =
        metric === 'cost'
            ? sql`coalesce(sum(${sessionTurns.total_cost_micros}), 0)`
            : sql`coalesce(sum(
                  ${sessionTurns.input_tokens} + ${sessionTurns.output_tokens}
                  + ${sessionTurns.cache_read_tokens} + ${sessionTurns.cache_write_tokens}
              ), 0)`;

    const rows = await db
        .select({
            id: models.id,
            name: models.name,
            requests: count(),
            tokens: sql<number>`coalesce(sum(
                ${sessionTurns.input_tokens} + ${sessionTurns.output_tokens}
                + ${sessionTurns.cache_read_tokens} + ${sessionTurns.cache_write_tokens}
            ), 0)`,
            costMicros: sql<number>`coalesce(sum(${sessionTurns.total_cost_micros}), 0)`,
            unpricedCount: sql<number>`coalesce(sum(${sessionTurns.unpriced_calls}), 0)`,
        })
        .from(sessionTurns)
        .innerJoin(models, eq(models.id, sessionTurns.model_id))
        .where(buildTurnWhere(filter))
        .groupBy(models.id, models.name)
        .orderBy(desc(orderExpr))
        .limit(limit)
        .all();

    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        subtitle: null,
        lastAt: null,
        requests: row.requests,
        tokens: row.tokens,
        costMicros: row.costMicros,
        unpricedCount: row.unpricedCount,
        durationMs: null,
    }));
};

/**
 * Session ranking.
 *
 * Duration is the sum of that session's turn durations, not the first-to-last
 * span: the span counts idle time in between and hides real intensity.
 */
export const getSessionRanking = async (
    filter: UsageFilter,
    metric: UsageRankMetric = 'tokens',
    limit = 8
): Promise<UsageRankItem[]> => {
    const orderExpr =
        metric === 'cost'
            ? sql`coalesce(sum(${sessionTurns.total_cost_micros}), 0)`
            : metric === 'duration'
              ? sql`coalesce(sum(${sessionTurns.duration_ms}), 0)`
              : sql`coalesce(sum(
                    ${sessionTurns.input_tokens} + ${sessionTurns.output_tokens}
                    + ${sessionTurns.cache_read_tokens} + ${sessionTurns.cache_write_tokens}
                ), 0)`;

    const rows = await db
        .select({
            id: sessions.id,
            title: sessions.title,
            modelName: sql<string>`coalesce(max(${models.name}), '')`,
            lastAt: sql<string>`max(${sessionTurns.created_at})`,
            requests: count(),
            tokens: sql<number>`coalesce(sum(
                ${sessionTurns.input_tokens} + ${sessionTurns.output_tokens}
                + ${sessionTurns.cache_read_tokens} + ${sessionTurns.cache_write_tokens}
            ), 0)`,
            costMicros: sql<number>`coalesce(sum(${sessionTurns.total_cost_micros}), 0)`,
            unpricedCount: sql<number>`coalesce(sum(${sessionTurns.unpriced_calls}), 0)`,
            durationMs: sql<number>`coalesce(sum(${sessionTurns.duration_ms}), 0)`,
        })
        .from(sessionTurns)
        .innerJoin(sessions, eq(sessions.id, sessionTurns.session_id))
        .leftJoin(models, eq(models.id, sessionTurns.model_id))
        .where(buildTurnWhere(filter))
        .groupBy(sessions.id, sessions.title)
        .orderBy(desc(orderExpr))
        .limit(limit)
        .all();

    return rows.map((row) => ({
        id: row.id,
        name: row.title || '—',
        subtitle: row.modelName || null,
        lastAt: row.lastAt ?? null,
        requests: row.requests,
        tokens: row.tokens,
        costMicros: row.costMicros,
        unpricedCount: row.unpricedCount,
        durationMs: row.durationMs,
    }));
};

/** Filter dropdown options, ordered by request count. */
export const getUsageFilterOptions = async (filter: UsageFilter): Promise<UsageFilterOptions> => {
    const [modelRows, providerRows] = await Promise.all([
        db
            .select({ id: models.id, name: models.name, count: count() })
            .from(sessionTurns)
            .innerJoin(models, eq(models.id, sessionTurns.model_id))
            .where(buildTurnWhere(filter))
            .groupBy(models.id, models.name)
            .orderBy(desc(count()))
            .all(),
        db
            .select({ id: providers.id, name: providers.name, count: count() })
            .from(sessionTurns)
            .innerJoin(models, eq(models.id, sessionTurns.model_id))
            .innerJoin(providers, eq(providers.id, models.provider_id))
            .where(buildTurnWhere(filter))
            .groupBy(providers.id, providers.name)
            .orderBy(desc(count()))
            .all(),
    ]);

    return {
        models: modelRows.map((row) => ({ id: row.id, name: row.name, count: row.count })),
        providers: providerRows.map((row) => ({ id: row.id, name: row.name, count: row.count })),
    };
};

// ============================================================================
// Composition (tokens and timings)
// ============================================================================

/**
 * Content composition and time composition.
 *
 * The two totals use different bases and must not be added:
 * - tokens describe what the context actually held, estimated from characters;
 * - timings describe where active time went, over the sum of turn durations.
 *
 * Cache reads are deliberately **not** a content slice: they are the same
 * content read again and belong to billing. As a slice they would take 70% or
 * more and crush the real composition into hairlines.
 */
export const getUsageComposition = async (filter: UsageFilter): Promise<UsageComposition> => {
    const where = buildTurnWhere(filter);

    const turns = await db
        .select({
            platform: sql<number>`coalesce(sum(json_extract(${sessionTurns.prompt_breakdown_json}, '$.fragments.platform')), 0)`,
            policy: sql<number>`coalesce(sum(json_extract(${sessionTurns.prompt_breakdown_json}, '$.fragments.policy')), 0)`,
            mode: sql<number>`coalesce(sum(json_extract(${sessionTurns.prompt_breakdown_json}, '$.fragments.mode')), 0)`,
            feature: sql<number>`coalesce(sum(json_extract(${sessionTurns.prompt_breakdown_json}, '$.fragments.feature')), 0)`,
            agentProfile: sql<number>`coalesce(sum(json_extract(${sessionTurns.prompt_breakdown_json}, '$.fragments.agent_profile')), 0)`,
            sessionMemory: sql<number>`coalesce(sum(json_extract(${sessionTurns.prompt_breakdown_json}, '$.fragments.session_memory')), 0)`,
            userAppend: sql<number>`coalesce(sum(json_extract(${sessionTurns.prompt_breakdown_json}, '$.fragments.user_append')), 0)`,
            override: sql<number>`coalesce(sum(json_extract(${sessionTurns.prompt_breakdown_json}, '$.fragments.override')), 0)`,
            builtinTools: sql<number>`coalesce(sum(json_extract(${sessionTurns.prompt_breakdown_json}, '$.builtinToolDefinitions')), 0)`,
            mcpTools: sql<number>`coalesce(sum(json_extract(${sessionTurns.prompt_breakdown_json}, '$.mcpToolDefinitions')), 0)`,
            userPrompt: sql<number>`coalesce(sum(json_extract(${sessionTurns.prompt_breakdown_json}, '$.userPrompt')), 0)`,
            attachments: sql<number>`coalesce(sum(json_extract(${sessionTurns.prompt_breakdown_json}, '$.attachments')), 0)`,
            outputTokens: sql<number>`coalesce(sum(${sessionTurns.output_tokens}), 0)`,
            inputTokens: sql<number>`coalesce(sum(${sessionTurns.input_tokens}), 0)`,
            cacheReadTokens: sql<number>`coalesce(sum(${sessionTurns.cache_read_tokens}), 0)`,
            totalDurationMs: sql<number>`coalesce(sum(${sessionTurns.duration_ms}), 0)`,
        })
        .from(sessionTurns)
        .where(where)
        .get();

    // History and tool results are estimated from part lengths; providers do not return prompt slices.
    const parts = await db
        .select({
            textChars: sql<number>`coalesce(sum(case when ${messageParts.type} = 'text' then length(${messageParts.content}) else 0 end), 0)`,
            reasoningChars: sql<number>`coalesce(sum(case when ${messageParts.type} = 'reasoning' then length(${messageParts.content}) else 0 end), 0)`,
            toolOutputChars: sql<number>`coalesce(sum(case when ${messageParts.type} = 'tool_call' then length(json_extract(${messageParts.data}, '$.output')) else 0 end), 0)`,
        })
        .from(messageParts)
        .where(between(messageParts.created_at, filter.from, filter.to))
        .get();

    // Timing split, all from call-level and tool-level timers.
    const timing = await db
        .select({
            wait: sql<number>`coalesce(sum(case when ${messageParts.type} = 'llm_call' then json_extract(${messageParts.data}, '$.timing.ttftMs') else 0 end), 0)`,
            // The span between first token and first content is thinking, for reasoning models only.
            think: sql<number>`coalesce(sum(case when ${messageParts.type} = 'llm_call'
                and json_extract(${messageParts.data}, '$.timing.firstTextMs') is not null
                and json_extract(${messageParts.data}, '$.timing.ttftMs') is not null
                then max(0, json_extract(${messageParts.data}, '$.timing.firstTextMs')
                        - json_extract(${messageParts.data}, '$.timing.ttftMs'))
                else 0 end), 0)`,
            reply: sql<number>`coalesce(sum(case when ${messageParts.type} = 'llm_call' then json_extract(${messageParts.data}, '$.timing.flowMs') else 0 end), 0)`,
            tool: sql<number>`coalesce(sum(case when ${messageParts.type} = 'tool_call' then json_extract(${messageParts.data}, '$.duration_ms') else 0 end), 0)`,
        })
        .from(messageParts)
        .where(between(messageParts.created_at, filter.from, filter.to))
        .get();

    const estimated = (chars: number) => estimateTokensFromChars(chars ?? 0);

    const tokenSegments: UsageCompositionSegment[] = [
        {
            key: 'systemPrompt',
            value: estimated((turns?.platform ?? 0) + (turns?.policy ?? 0)),
            estimated: true,
        },
        {
            key: 'toolDefinitions',
            value: estimated((turns?.builtinTools ?? 0) + (turns?.mcpTools ?? 0)),
            estimated: true,
        },
        {
            key: 'conversation',
            value: estimated((parts?.textChars ?? 0) + (parts?.reasoningChars ?? 0)),
            estimated: true,
        },
        { key: 'toolResults', value: estimated(parts?.toolOutputChars ?? 0), estimated: true },
        { key: 'userPrompt', value: estimated(turns?.userPrompt ?? 0), estimated: true },
        {
            key: 'injections',
            value: estimated(
                (turns?.mode ?? 0) +
                    (turns?.feature ?? 0) +
                    (turns?.agentProfile ?? 0) +
                    (turns?.sessionMemory ?? 0) +
                    (turns?.userAppend ?? 0) +
                    (turns?.override ?? 0) +
                    (turns?.attachments ?? 0)
            ),
            estimated: true,
        },
        // Output is the measured value from the provider and includes reasoning.
        { key: 'output', value: turns?.outputTokens ?? 0, estimated: false },
    ];

    const totalMs = turns?.totalDurationMs ?? 0;
    const wait = timing?.wait ?? 0;
    const think = timing?.think ?? 0;
    const reply = timing?.reply ?? 0;
    const tool = timing?.tool ?? 0;
    // Argument building and gaps take the remainder; the four measured parts often exceed the turn duration.
    const other = Math.max(0, totalMs - wait - think - reply - tool);

    const billingInput = (turns?.inputTokens ?? 0) + (turns?.cacheReadTokens ?? 0);

    return {
        tokens: {
            total: tokenSegments.reduce((sum, segment) => sum + segment.value, 0),
            segments: tokenSegments.filter((segment) => segment.value > 0),
        },
        timing: {
            totalMs,
            segments: [
                { key: 'wait', value: wait, estimated: false },
                { key: 'think', value: think, estimated: false },
                { key: 'reply', value: reply, estimated: false },
                { key: 'tool', value: tool, estimated: false },
                { key: 'other', value: other, estimated: false },
            ].filter((segment) => segment.value > 0),
        },
        cacheReadShare: billingInput > 0 ? (turns?.cacheReadTokens ?? 0) / billingInput : 0,
    };
};

// ============================================================================
// Tool call stats
// ============================================================================

/**
 * Tool call stats.
 *
 * The source is `tool_call` parts, the single source of truth for tool runs.
 * Names are rebuilt from the raw fields in `data` rather than reused from the
 * render layer's display format.
 */
export const getToolUsageStats = async (filter: UsageFilter): Promise<ToolUsageSummary> => {
    const nameExpr = sql<string | null>`case json_extract(${messageParts.data}, '$.toolKind')
        when 'builtin' then 'builtin__' || json_extract(${messageParts.data}, '$.tool_id')
        when 'mcp' then 'mcp__' || coalesce(json_extract(${messageParts.data}, '$.server_id'), '')
            || '__' || coalesce(json_extract(${messageParts.data}, '$.tool_name'), '')
        else null end`;
    const kindExpr = sql<string>`json_extract(${messageParts.data}, '$.toolKind')`;
    const statusExpr = sql<string>`json_extract(${messageParts.data}, '$.status')`;
    const durationExpr = sql<number | null>`json_extract(${messageParts.data}, '$.duration_ms')`;

    const rows = await db
        .select({
            name: nameExpr.as('name'),
            kind: kindExpr.as('kind'),
            status: statusExpr.as('status'),
            count: count(),
            sumDuration: sql<number>`coalesce(sum(${durationExpr}), 0)`,
            durationCount: sql<number>`count(${durationExpr})`,
        })
        .from(messageParts)
        .where(
            and(
                eq(messageParts.type, 'tool_call'),
                between(messageParts.created_at, filter.from, filter.to)
            )
        )
        .groupBy(nameExpr, kindExpr, statusExpr)
        .all();

    // Merge different statuses of the same tool into one row.
    const byTool = new Map<
        string,
        ToolUsageStat & { sumDuration: number; durationCount: number }
    >();
    let totalCount = 0;
    let errorCount = 0;
    let sumDuration = 0;
    let durationCount = 0;

    for (const row of rows) {
        const name = row.name ?? '—';
        const isError =
            row.status === 'error' || row.status === 'timeout' || row.status === 'rejected';

        totalCount += row.count;
        if (isError) {
            errorCount += row.count;
        }
        sumDuration += row.sumDuration;
        durationCount += row.durationCount;

        let entry = byTool.get(name);
        if (!entry) {
            entry = {
                name,
                kind: row.kind === 'mcp' ? 'mcp' : 'builtin',
                count: 0,
                errorCount: 0,
                meanDurationMs: null,
                sumDuration: 0,
                durationCount: 0,
            };
            byTool.set(name, entry);
        }

        entry.count += row.count;
        if (isError) {
            entry.errorCount += row.count;
        }
        entry.sumDuration += row.sumDuration;
        entry.durationCount += row.durationCount;
    }

    const byToolList = [...byTool.values()]
        .map((entry) => ({
            name: entry.name,
            kind: entry.kind,
            count: entry.count,
            errorCount: entry.errorCount,
            meanDurationMs:
                entry.durationCount > 0
                    ? Math.round(entry.sumDuration / entry.durationCount)
                    : null,
        }))
        .sort((left, right) => right.count - left.count);

    return {
        totalCount,
        errorCount,
        distinctTools: byToolList.length,
        meanDurationMs: durationCount > 0 ? Math.round(sumDuration / durationCount) : null,
        byTool: byToolList,
    };
};

// ============================================================================
// Heatmap
// ============================================================================

/**
 * Heatmap cells.
 */
/** Database timestamp format (UTC), matching created_at. */
function toDbTimestamp(date: Date): string {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Heatmap aggregated by day over the last year.
 *
 * The heatmap always shows a full year, so it ignores the range: a "today"
 * filter would leave one coloured cell and an empty grid. Model and provider
 * filters still apply; only the time window is pinned to a year.
 */
export const getUsageHeatmap = async (filter: UsageFilter): Promise<UsageHeatmapDay[]> => {
    const dayExpr = sql<string>`date(${sessionTurns.created_at}, 'localtime')`;
    const hourExpr = sql<number>`cast(strftime('%H', ${sessionTurns.created_at}, 'localtime') as integer)`;
    const yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);

    const rows = await db
        .select({
            day: dayExpr.as('day'),
            hour: hourExpr.as('hour'),
            requests: count(),
            tokens: sql<number>`coalesce(sum(
                ${sessionTurns.input_tokens} + ${sessionTurns.output_tokens}
                + ${sessionTurns.cache_read_tokens} + ${sessionTurns.cache_write_tokens}
            ), 0)`,
            costMicros: sql<number>`coalesce(sum(${sessionTurns.total_cost_micros}), 0)`,
        })
        .from(sessionTurns)
        .where(
            buildTurnWhere({
                ...filter,
                from: toDbTimestamp(yearAgo),
                to: toDbTimestamp(new Date()),
            })
        )
        .groupBy(dayExpr, hourExpr)
        .orderBy(dayExpr, hourExpr)
        .all();

    return rows;
};
