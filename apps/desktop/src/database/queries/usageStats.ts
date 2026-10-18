// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { and, between, count, desc, eq, gte, inArray, like, or, type SQL, sql } from 'drizzle-orm';

import { db } from '../index';
import { messageParts, models, providers, sessionTurns } from '../schema';

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

export interface UsageTrendPoint {
    key: string;
    requests: number;
    tokens: number;
    costMicros: number;
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

export interface UsageCallRow {
    partId: number;
    messageId: number;
    sessionId: number | null;
    sessionTitle: string | null;
    createdAt: string;
    modelName: string;
    providerName: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    costMicros: number;
    priced: boolean;
    ttftMs: number | null;
    durationMs: number | null;
    finishReason: string | null;
    errorMessage: string | null;
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

export const getUsageTrend = async (
    filter: UsageFilter
): Promise<{ bucket: 'hour' | 'day'; points: UsageTrendPoint[] }> => {
    const spanMs = new Date(filter.to).getTime() - new Date(filter.from).getTime();
    const bucket: 'hour' | 'day' = spanMs <= 48 * 60 * 60 * 1000 ? 'hour' : 'day';

    const keyExpr =
        bucket === 'hour'
            ? sql<string>`strftime('%Y-%m-%d %H:00', ${sessionTurns.created_at}, 'localtime')`
            : sql<string>`date(${sessionTurns.created_at}, 'localtime')`;

    const rows = await db
        .select({
            key: keyExpr.as('key'),
            requests: count(),
            tokens: sql<number>`coalesce(sum(
                ${sessionTurns.input_tokens} + ${sessionTurns.output_tokens}
                + ${sessionTurns.cache_read_tokens} + ${sessionTurns.cache_write_tokens}
            ), 0)`,
            costMicros: sql<number>`coalesce(sum(${sessionTurns.total_cost_micros}), 0)`,
        })
        .from(sessionTurns)
        .where(buildTurnWhere(filter))
        .groupBy(keyExpr)
        .orderBy(keyExpr)
        .all();

    return { bucket, points: rows };
};

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
// 热力图（固定窗口，不受 filter 的 from/to 影响）
// ============================================================================

export const getUsageHeatmap = async (weeks = 53): Promise<UsageHeatmapDay[]> => {
    const since = sql`datetime('now', '-${sql.raw(String(weeks * 7))} days')`;
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
        .where(gte(sessionTurns.created_at, since))
        .groupBy(dayExpr)
        .orderBy(dayExpr)
        .all();

    return rows;
};

// ============================================================================
// 调用账本（走 llm_call 片段的表达式索引）
// ============================================================================

function callJson(field: string) {
    return sql<string | null>`json_extract(${messageParts.data}, '${sql.raw(field)}')`;
}

/**
 * 调用账本的 WHERE。
 *
 * 模型/供应商/搜索走片段载荷里的字段；状态与重试要走回合，
 * 所以载荷里记了 `turnId`。
 */
function buildCallWhere(filter: UsageFilter): SQL {
    const clauses: Array<SQL | undefined> = [
        eq(messageParts.type, 'llm_call'),
        between(messageParts.created_at, filter.from, filter.to),
    ];

    if (filter.modelIds?.length) {
        const ids = filter.modelIds;
        clauses.push(
            sql`json_extract(${messageParts.data}, '$.modelId') IN (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `
            )})`
        );
    }

    if (filter.providerIds?.length) {
        const ids = filter.providerIds;
        clauses.push(
            sql`json_extract(${messageParts.data}, '$.providerId') IN (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `
            )})`
        );
    }

    if (filter.statuses?.length) {
        const statuses = filter.statuses;
        clauses.push(
            sql`json_extract(${messageParts.data}, '$.turnId') IN (
                SELECT ${sessionTurns.id} FROM ${sessionTurns}
                WHERE ${sessionTurns.status} IN (${sql.join(
                    statuses.map((status) => sql`${status}`),
                    sql`, `
                )})
            )`
        );
    }

    if (filter.onlyRetried) {
        clauses.push(
            sql`json_extract(${messageParts.data}, '$.turnId') IN (
                SELECT ${sessionTurns.id} FROM ${sessionTurns}
                WHERE (SELECT count(*) FROM session_turn_attempts WHERE turn_id = ${sessionTurns.id}) > 1
            )`
        );
    }

    if (filter.search?.trim()) {
        const pattern = `%${filter.search.trim()}%`;
        clauses.push(
            sql`(json_extract(${messageParts.data}, '$.modelName') LIKE ${pattern}
                 OR json_extract(${messageParts.data}, '$.providerName') LIKE ${pattern})`
        );
    }

    return and(...clauses)!;
}

export const getUsageCallPage = async (
    filter: UsageFilter,
    offset: number,
    limit: number
): Promise<{ rows: UsageCallRow[]; total: number }> => {
    const where = buildCallWhere(filter);

    const totalRow = await db.select({ value: count() }).from(messageParts).where(where).get();

    const rows = await db
        .select({
            partId: messageParts.id,
            messageId: messageParts.message_id,
            sessionId: sql<
                number | null
            >`(SELECT session_id FROM messages WHERE id = ${messageParts.message_id})`,
            sessionTitle: sql<string | null>`(
                SELECT sessions.title FROM sessions
                INNER JOIN messages ON messages.session_id = sessions.id
                WHERE messages.id = ${messageParts.message_id}
            )`,
            createdAt: messageParts.created_at,
            modelName: sql<string>`coalesce(json_extract(${messageParts.data}, '$.modelName'), '')`,
            providerName: sql<string>`coalesce(json_extract(${messageParts.data}, '$.providerName'), '')`,
            inputTokens: sql<number>`coalesce(json_extract(${messageParts.data}, '$.usage.inputTokens'), 0)`,
            outputTokens: sql<number>`coalesce(json_extract(${messageParts.data}, '$.usage.outputTokens'), 0)`,
            cacheReadTokens: sql<number>`coalesce(json_extract(${messageParts.data}, '$.usage.cacheReadTokens'), 0)`,
            cacheWriteTokens: sql<number>`coalesce(json_extract(${messageParts.data}, '$.usage.cacheWriteTokens'), 0)`,
            reasoningTokens: sql<number>`coalesce(json_extract(${messageParts.data}, '$.usage.reasoningTokens'), 0)`,
            costMicros: sql<number>`coalesce(json_extract(${messageParts.data}, '$.costMicros'), 0)`,
            priced: sql<number>`coalesce(json_extract(${messageParts.data}, '$.priced'), 0)`,
            ttftMs: sql<number | null>`json_extract(${messageParts.data}, '$.timing.ttftMs')`,
            durationMs: sql<
                number | null
            >`json_extract(${messageParts.data}, '$.timing.durationMs')`,
            finishReason: callJson('$.finishReason'),
            errorMessage: callJson('$.errorMessage'),
        })
        .from(messageParts)
        .where(where)
        .orderBy(desc(messageParts.created_at), desc(messageParts.id))
        .limit(limit)
        .offset(offset)
        .all();

    return {
        rows: rows.map((row) => ({
            ...row,
            priced: row.priced === 1,
            modelName: row.modelName || '—',
            providerName: row.providerName || '—',
        })),
        total: totalRow?.value ?? 0,
    };
};
