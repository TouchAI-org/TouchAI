// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    and,
    between,
    count,
    desc,
    eq,
    gte,
    inArray,
    like,
    lte,
    or,
    type SQL,
    sql,
} from 'drizzle-orm';

import { db } from '../index';
import {
    messageParts,
    models,
    providers,
    sessions,
    sessionTurns,
    usageDailyRollups,
} from '../schema';

// ============================================================================
// 类型
// ============================================================================

export type UsageRangePreset = 'today' | '24h' | '7d' | '30d' | 'all' | 'custom';

export interface UsageFilter {
    /** ISO 日期时间，含 */
    from: string;
    /** ISO 日期时间，含 */
    to: string;
    modelIds?: number[];
    providerIds?: number[];
    statuses?: Array<'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled'>;
    onlyFailed?: boolean;
    onlyRetried?: boolean;
    search?: string;
}

export interface UsageSummary {
    /** 回合数 */
    requestCount: number;
    /** 产生过用量的会话数 */
    sessionCount: number;
    successCount: number;
    totalCostMicros: number;
    unpricedCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    /** 新鲜输入 + 输出 + 缓存读 + 缓存写 */
    realTotalTokens: number;
    /** cacheRead / (input + cacheWrite + cacheRead) */
    cacheHitRate: number;
    successRate: number;
    meanTtftMs: number | null;
    meanDurationMs: number | null;
    /** 平均解码速度（tok/s），样本不足时为 null */
    decodeSpeed: number | null;
}

/** 一个时间桶里按模型（或供应商）拆开的一段 */
export interface UsageTrendSegment {
    /** 分组 id；分组已不存在时为 null */
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
    /** 堆叠柱的拆分；按总量降序，UI 取前 N 段并合并其余 */
    segments: UsageTrendSegment[];
}

/** 排行项：模型或会话 */
export interface UsageRankItem {
    id: number;
    /** 主标题：模型名或会话标题 */
    name: string;
    /** 副标题：会话条目用（模型名等）；模型条目为空 */
    subtitle: string | null;
    /** 最后活跃时间（会话条目用） */
    lastAt: string | null;
    requests: number;
    tokens: number;
    costMicros: number;
    unpricedCount: number;
    /** 会话时长（毫秒）；模型条目为 null */
    durationMs: number | null;
}

/** 排行维度：与界面的三档切换对应 */
export type UsageRankMetric = 'tokens' | 'cost' | 'duration';

/** 工具调用统计（来自 `tool_call` 片段） */
export interface ToolUsageStat {
    /** 工具调用名，如 `builtin__read` / `mcp__server__tool` */
    name: string;
    kind: 'builtin' | 'mcp';
    count: number;
    errorCount: number;
    /** 平均耗时；无样本时为 null */
    meanDurationMs: number | null;
}

export interface ToolUsageSummary {
    totalCount: number;
    errorCount: number;
    /** 用过多少种工具 */
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
    requests: number;
    tokens: number;
    costMicros: number;
}

export interface UsageFilterOptions {
    models: Array<{ id: number; name: string; count: number }>;
    providers: Array<{ id: number; name: string; count: number }>;
}

// ============================================================================
// 内部：WHERE 构造
// ============================================================================

/** 构建回合级 WHERE。所有聚合查询共用，保证口径一致。 */
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
        // 重试过的回合：尝试数 > 1
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

/** 计算缓存命中率：cacheRead / (input + cacheWrite + cacheRead) */
function computeCacheHitRate(input: number, cacheRead: number, cacheWrite: number): number {
    const denominator = input + cacheWrite + cacheRead;
    return denominator > 0 ? cacheRead / denominator : 0;
}

// ============================================================================
// 汇总
// ============================================================================

export const getUsageSummary = async (filter: UsageFilter): Promise<UsageSummary> => {
    const row = await db
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
            sumDuration: sql<number>`coalesce(sum(${sessionTurns.duration_ms}), 0)`,
            durationCount: sql<number>`count(${sessionTurns.duration_ms})`,
            sessionCount: sql<number>`count(distinct ${sessionTurns.session_id})`,
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

    return {
        requestCount,
        sessionCount: row?.sessionCount ?? 0,
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
        meanDurationMs,
        // 粗算解码速度：输出 token / 总耗时。精确值需要 flowMs，
        // 但回合级没有该字段；UI 上标注为「≈」。
        decodeSpeed:
            meanDurationMs !== null && outputTokens > 0
                ? outputTokens / requestCount / (meanDurationMs / 1000)
                : null,
    };
};

// ============================================================================
// 趋势
// ============================================================================

/**
 * 趋势：按时间桶汇总，并在桶内按模型（或供应商）拆成堆叠段。
 *
 * 一次查询拿到「桶 × 分组」的组合，再在内存里折叠成桶。
 * 分组维度由 `dimension` 决定，与图表上的切换按钮一致。
 */
export const getUsageTrend = async (
    filter: UsageFilter,
    dimension: 'model' | 'provider' = 'model'
): Promise<{ bucket: 'hour' | 'day'; points: UsageTrendPoint[] }> => {
    const spanMs = new Date(filter.to).getTime() - new Date(filter.from).getTime();
    const bucket: 'hour' | 'day' = spanMs <= 48 * 60 * 60 * 1000 ? 'hour' : 'day';

    const keyExpr =
        bucket === 'hour'
            ? sql<string>`strftime('%Y-%m-%d %H:00', ${sessionTurns.created_at}, 'localtime')`
            : sql<string>`date(${sessionTurns.created_at}, 'localtime')`;

    const groupIdExpr =
        dimension === 'model'
            ? sql<number>`${models.id}`
            : sql<number>`coalesce(${providers.id}, 0)`;
    const groupNameExpr =
        dimension === 'model'
            ? sql<string>`${models.name}`
            : sql<string>`coalesce(${providers.name}, '—')`;

    const rows = await db
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

    // 按桶折叠；每桶内的分组按 token 量降序，方便图表取前 N 段
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
            // 供应商维度用 0 代表「无」；模型维度保留真实 id
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

    return { bucket, points: [...byBucket.values()] };
};

/**
 * 「全部时间」趋势：走日汇总表。
 *
 * 日汇总永久保留且只有几十行，而 `session_turns` 会被「清理会话轮次」
 * 或后续的保留策略清空。用归档表回答「历史上总共花了多少」才不会随清理归零。
 *
 * 只适用于没有模型/供应商筛选的场景：汇总表按名字而非 id 存储，
 * 无法参与基于 id 的筛选。
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
            // 归档表按名字存储，没有 id
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

/** 筛选会影响趋势时不能使用归档表（归档表不含 id 维度） */
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
// 排行
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
 * 模型排行：按所选指标排序。
 *
 * 与 `getUsageByModel` 的区别：那个返回完整字段供表格展示，
 * 这里只给排行需要的量，并按 `metric` 排序。
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
 * 会话排行。
 *
 * 时长口径是「该会话里所有回合的耗时之和」，不是首末时间差：
 * 后者会把中间不用的时间也算进去，无法反映真实对话强度。
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

/** 筛选下拉的候选列表（按请求数降序） */
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
// 工具调用统计
// ============================================================================

/**
 * 工具调用统计。
 *
 * 数据源是 `tool_call` 片段——工具执行的唯一真相源。
 * 工具名从 `data` 里的原始字段拼出，而不是复用渲染层的展示格式。
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

    // 同一工具的不同状态要合并成一行
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
// 热力图（跟随所选区间）
// ============================================================================

/**
 * 热力图。
 *
 * 跟随所选区间，而不是固定一年：选了“近 7 天”却看到一整年的格子
 * 会让人误以为筛选没生效。
 */
export const getUsageHeatmap = async (
    filter: Pick<UsageFilter, 'from' | 'to'>
): Promise<UsageHeatmapDay[]> => {
    const dayExpr = sql<string>`date(${sessionTurns.created_at}, 'localtime')`;

    const rows = await db
        .select({
            day: dayExpr.as('day'),
            requests: count(),
            tokens: sql<number>`coalesce(sum(
                ${sessionTurns.input_tokens} + ${sessionTurns.output_tokens}
                + ${sessionTurns.cache_read_tokens} + ${sessionTurns.cache_write_tokens}
            ), 0)`,
            costMicros: sql<number>`coalesce(sum(${sessionTurns.total_cost_micros}), 0)`,
        })
        .from(sessionTurns)
        .where(
            and(gte(sessionTurns.created_at, filter.from), lte(sessionTurns.created_at, filter.to))
        )
        .groupBy(dayExpr)
        .orderBy(dayExpr)
        .all();

    return rows;
};
