// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { native } from '@services/NativeService';
import type {
    DatabaseUsageDimension,
    DatabaseUsageRankMetric,
} from '@services/NativeService/database';

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
    requestCount: number;
    sessionCount: number;
    activeDayCount: number;
    totalDurationMs: number;
    firstRequestAt: string | null;
    successCount: number;
    totalCostMicros: number;
    unpricedCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    realTotalTokens: number;
    cacheHitRate: number;
    successRate: number;
    meanTtftMs: number | null;
    meanFirstTextMs: number | null;
    meanDurationMs: number | null;
    decodeSpeed: number | null;
}

export interface UsageLiveTurn {
    taskId: string;
    createdAt: string;
    status: string;
    outputTokens: number;
    totalCostMicros: number;
    durationMs: number | null;
}

export type UsageBucket = 'minute' | 'hour' | 'day';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export const USAGE_TARGET_BUCKETS = 48;
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

/** Pick the bucket width for a range span. */
export function resolveUsageBucketMs(spanMs: number): number {
    if (!(spanMs > 0)) return 10 * 60_000;
    const ideal = spanMs / USAGE_TARGET_BUCKETS;
    return BUCKET_STEPS.find((step) => step >= ideal) ?? DAY_MS;
}

export function bucketKindOf(bucketMs: number): UsageBucket {
    if (bucketMs >= DAY_MS) return 'day';
    if (bucketMs >= HOUR_MS) return 'hour';
    return 'minute';
}

export function resolveUsageBucket(spanMs: number): UsageBucket {
    return bucketKindOf(resolveUsageBucketMs(spanMs));
}

export interface UsageTrendSegment {
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
    segments: UsageTrendSegment[];
}

export interface UsageRankItem {
    id: number;
    name: string;
    subtitle: string | null;
    lastAt: string | null;
    requests: number;
    tokens: number;
    costMicros: number;
    unpricedCount: number;
    durationMs: number | null;
}

export type UsageRankMetric = 'tokens' | 'cost' | 'duration';

export interface UsageCompositionSegment {
    key: string;
    value: number;
    estimated: boolean;
}

export interface UsageComposition {
    tokens: { total: number; segments: UsageCompositionSegment[] };
    timing: { totalMs: number; segments: UsageCompositionSegment[] };
    cacheReadShare: number;
}

export interface ToolUsageStat {
    name: string;
    kind: 'builtin' | 'mcp';
    count: number;
    errorCount: number;
    meanDurationMs: number | null;
}

export interface ToolUsageSummary {
    totalCount: number;
    errorCount: number;
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

export interface UsageHeatmapDay {
    day: string;
    hour: number;
    requests: number;
    tokens: number;
    costMicros: number;
}

export interface UsageFilterOptions {
    models: Array<{ id: number; name: string; count: number }>;
    providers: Array<{ id: number; name: string; count: number }>;
}

function dimensionValue(dimension: 'model' | 'provider'): DatabaseUsageDimension {
    return dimension;
}

function metricValue(metric: UsageRankMetric): DatabaseUsageRankMetric {
    return metric;
}

export const getUsageSummary = (filter: UsageFilter): Promise<UsageSummary> =>
    native.database.operation<UsageSummary>({ kind: 'usage_summary', filter });

export const getUsageDashboardSnapshot = (
    filter: UsageFilter,
    taskIds: string[],
    dimension: 'model' | 'provider' = 'model'
): Promise<{
    summary: UsageSummary;
    liveTurns: UsageLiveTurn[];
    trend: { bucket: UsageBucket; bucketMs: number; points: UsageTrendPoint[] };
}> =>
    native.database.operation({
        kind: 'usage_dashboard',
        filter,
        taskIds,
        dimension: dimensionValue(dimension),
    });

export const getUsageTrend = (
    filter: UsageFilter,
    dimension: 'model' | 'provider' = 'model'
): Promise<{ bucket: UsageBucket; bucketMs: number; points: UsageTrendPoint[] }> =>
    native.database.operation({
        kind: 'usage_trend',
        filter,
        dimension: dimensionValue(dimension),
    });

export const getUsageTrendFromArchive = (): Promise<{
    bucket: 'day';
    points: UsageTrendPoint[];
}> => native.database.operation({ kind: 'usage_archive_trend' });

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

export const getUsageByModel = (filter: UsageFilter): Promise<UsageGroup[]> =>
    native.database.operation({ kind: 'usage_by_model', filter });

export const getUsageByProvider = (filter: UsageFilter): Promise<UsageGroup[]> =>
    native.database.operation({ kind: 'usage_by_provider', filter });

export const getModelRanking = (
    filter: UsageFilter,
    metric: UsageRankMetric = 'tokens',
    limit = 8
): Promise<UsageRankItem[]> =>
    native.database.operation({
        kind: 'usage_model_ranking',
        filter,
        metric: metricValue(metric),
        limit,
    });

export const getSessionRanking = (
    filter: UsageFilter,
    metric: UsageRankMetric = 'tokens',
    limit = 8
): Promise<UsageRankItem[]> =>
    native.database.operation({
        kind: 'usage_session_ranking',
        filter,
        metric: metricValue(metric),
        limit,
    });

export const getUsageFilterOptions = (filter: UsageFilter): Promise<UsageFilterOptions> =>
    native.database.operation({ kind: 'usage_filter_options', filter });

export const getUsageComposition = (filter: UsageFilter): Promise<UsageComposition> =>
    native.database.operation({ kind: 'usage_composition', filter });

export const getToolUsageStats = (filter: UsageFilter): Promise<ToolUsageSummary> =>
    native.database.operation({ kind: 'usage_tool_stats', filter });

/** Database timestamp format (UTC), matching created_at. */
function toDbTimestamp(date: Date): string {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

export const getUsageHeatmap = async (filter: UsageFilter): Promise<UsageHeatmapDay[]> => {
    const yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    return native.database.operation({
        kind: 'usage_heatmap',
        filter: {
            ...filter,
            from: toDbTimestamp(yearAgo),
            to: toDbTimestamp(new Date()),
        },
    });
};
