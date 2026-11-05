import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import {
    estimateTokensFromChars,
    parsePromptBreakdown,
    sumFragmentChars,
} from '@/utils/promptBreakdown';

type Data = Record<string, unknown>;
type OperationRequest = Data & { kind: string };
type UsageFilter = {
    from: string;
    to: string;
    modelIds?: number[];
    providerIds?: number[];
    statuses?: string[];
    onlyFailed?: boolean;
    onlyRetried?: boolean;
    search?: string;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const BUCKET_STEPS = [
    60_000,
    120_000,
    300_000,
    600_000,
    900_000,
    1_800_000,
    HOUR_MS,
    2 * HOUR_MS,
    3 * HOUR_MS,
    6 * HOUR_MS,
    12 * HOUR_MS,
    DAY_MS,
];
const COMPACTION_MIN_TOKENS = 20_000;
const COMPACTION_RATIO = 0.6;
const SAMPLE_LIMIT = 5_000;
const SHARE_ORDER = [
    'systemPrompt',
    'builtinToolDefinitions',
    'mcpToolDefinitions',
    'conversation',
    'userPrompt',
    'attachments',
] as const;

const ROLLUP_SQL = `
    INSERT INTO usage_daily_rollups (
        day, model_name, provider_name,
        request_count, success_count,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_cost_micros, unpriced_count,
        sum_ttft_ms, sum_duration_ms, ttft_sample_count
    )
    SELECT
        date(t.created_at) AS day,
        coalesce(m.name, '—') AS model_name,
        coalesce(p.name, '—') AS provider_name,
        count(*) AS request_count,
        sum(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS success_count,
        coalesce(sum(t.input_tokens), 0),
        coalesce(sum(t.output_tokens), 0),
        coalesce(sum(t.cache_read_tokens), 0),
        coalesce(sum(t.cache_write_tokens), 0),
        coalesce(sum(t.reasoning_tokens), 0),
        coalesce(sum(t.total_cost_micros), 0),
        coalesce(sum(t.unpriced_calls), 0),
        coalesce(sum(t.ttft_ms), 0),
        coalesce(sum(t.duration_ms), 0),
        count(t.ttft_ms) AS ttft_sample_count
    FROM session_turns t
    LEFT JOIN models m ON m.id = t.model_id
    LEFT JOIN providers p ON p.id = m.provider_id
    GROUP BY day, model_name, provider_name
    ON CONFLICT(day, model_name, provider_name) DO UPDATE SET
        request_count = excluded.request_count,
        success_count = excluded.success_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        total_cost_micros = excluded.total_cost_micros,
        unpriced_count = excluded.unpriced_count,
        sum_ttft_ms = excluded.sum_ttft_ms,
        sum_duration_ms = excluded.sum_duration_ms,
        ttft_sample_count = excluded.ttft_sample_count
`;

function number(value: unknown): number {
    return typeof value === 'number' ? value : Number(value ?? 0);
}

function string(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function placeholders(count: number): string {
    return Array.from({ length: count }, () => '?').join(', ');
}

function where(filter: UsageFilter, extra = ''): { sql: string; params: SQLInputValue[] } {
    const clauses = ['session_turns.created_at BETWEEN ? AND ?'];
    const params: SQLInputValue[] = [filter.from, filter.to];
    if (filter.modelIds?.length) {
        clauses.push(`session_turns.model_id IN (${placeholders(filter.modelIds.length)})`);
        params.push(...filter.modelIds);
    }
    if (filter.providerIds?.length) {
        clauses.push(`session_turns.model_id IN (
            SELECT id FROM models WHERE provider_id IN (${placeholders(filter.providerIds.length)})
        )`);
        params.push(...filter.providerIds);
    }
    if (filter.statuses?.length) {
        clauses.push(`session_turns.status IN (${placeholders(filter.statuses.length)})`);
        params.push(...filter.statuses);
    }
    if (filter.onlyFailed) clauses.push("session_turns.status = 'failed'");
    if (filter.onlyRetried) {
        clauses.push(
            '(SELECT count(*) FROM session_turn_attempts WHERE turn_id = session_turns.id) > 1'
        );
    }
    const search = filter.search?.trim();
    if (search) {
        clauses.push(`(
            session_turns.error_message LIKE ?
            OR session_turns.model_id IN (
                SELECT models.id FROM models
                INNER JOIN providers ON providers.id = models.provider_id
                WHERE models.name LIKE ? OR models.model_id LIKE ? OR providers.name LIKE ?
            )
        )`);
        const pattern = `%${search}%`;
        params.push(pattern, pattern, pattern, pattern);
    }
    if (extra) clauses.push(extra);
    return { sql: ` WHERE ${clauses.join(' AND ')}`, params };
}

function resolveBucketMs(filter: UsageFilter): number {
    const span = new Date(filter.to).getTime() - new Date(filter.from).getTime();
    if (!(span > 0)) return 600_000;
    const ideal = span / 48;
    return BUCKET_STEPS.find((step) => step >= ideal) ?? DAY_MS;
}

function bucketKind(bucketMs: number): 'minute' | 'hour' | 'day' {
    if (bucketMs >= DAY_MS) return 'day';
    if (bucketMs >= HOUR_MS) return 'hour';
    return 'minute';
}

function formatBucketKey(at: Date, bucket: 'minute' | 'hour' | 'day'): string {
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

function summary(database: SqliteDatabase, filter: UsageFilter): Data {
    const condition = where(filter);
    const row = database
        .prepare(
            `SELECT
                count(*) AS request_count,
                coalesce(sum(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)
                    AS success_count,
                coalesce(sum(total_cost_micros), 0) AS total_cost_micros,
                coalesce(sum(unpriced_calls), 0) AS unpriced_count,
                coalesce(sum(input_tokens), 0) AS input_tokens,
                coalesce(sum(output_tokens), 0) AS output_tokens,
                coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens,
                coalesce(sum(cache_write_tokens), 0) AS cache_write_tokens,
                coalesce(sum(reasoning_tokens), 0) AS reasoning_tokens,
                coalesce(sum(ttft_ms), 0) AS sum_ttft,
                count(ttft_ms) AS ttft_count,
                coalesce(sum(first_text_ms), 0) AS sum_first_text,
                count(first_text_ms) AS first_text_count,
                coalesce(sum(duration_ms), 0) AS sum_duration,
                count(duration_ms) AS duration_count,
                count(DISTINCT session_id) AS session_count,
                count(DISTINCT date(created_at, 'localtime')) AS active_day_count,
                min(created_at) AS first_request_at
             FROM session_turns${condition.sql}`
        )
        .get(...condition.params) as Data;

    const requestCount = number(row.request_count);
    const successCount = number(row.success_count);
    const inputTokens = number(row.input_tokens);
    const outputTokens = number(row.output_tokens);
    const cacheReadTokens = number(row.cache_read_tokens);
    const cacheWriteTokens = number(row.cache_write_tokens);
    const meanDurationMs =
        number(row.duration_count) > 0
            ? Math.round(number(row.sum_duration) / number(row.duration_count))
            : null;
    return {
        requestCount,
        sessionCount: number(row.session_count),
        activeDayCount: number(row.active_day_count),
        totalDurationMs: number(row.sum_duration),
        firstRequestAt: row.first_request_at ?? null,
        successCount,
        totalCostMicros: number(row.total_cost_micros),
        unpricedCount: number(row.unpriced_count),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens: number(row.reasoning_tokens),
        realTotalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        cacheHitRate:
            inputTokens + cacheWriteTokens + cacheReadTokens > 0
                ? cacheReadTokens / (inputTokens + cacheWriteTokens + cacheReadTokens)
                : 0,
        successRate: requestCount > 0 ? successCount / requestCount : 0,
        meanTtftMs:
            number(row.ttft_count) > 0
                ? Math.round(number(row.sum_ttft) / number(row.ttft_count))
                : null,
        meanFirstTextMs:
            number(row.first_text_count) > 0
                ? Math.round(number(row.sum_first_text) / number(row.first_text_count))
                : null,
        meanDurationMs,
        decodeSpeed:
            meanDurationMs && meanDurationMs > 0 && requestCount > 0 && outputTokens > 0
                ? outputTokens / requestCount / (meanDurationMs / 1000)
                : null,
    };
}

function trend(database: SqliteDatabase, filter: UsageFilter, dimension: 'model' | 'provider') {
    const bucketMs = resolveBucketMs(filter);
    const bucket = bucketKind(bucketMs);
    const bucketSeconds = Math.max(60, Math.round(bucketMs / 1000));
    const condition = where(filter);
    const groupId = dimension === 'model' ? 'models.id' : 'coalesce(providers.id, 0)';
    const groupName = dimension === 'model' ? 'models.name' : "coalesce(providers.name, '—')";
    const rows = database
        .prepare(
            `SELECT
                cast(cast(strftime('%s', session_turns.created_at) AS integer) / ? AS integer)
                    AS bucket_key,
                ${groupId} AS group_id,
                ${groupName} AS group_name,
                count(*) AS requests,
                coalesce(sum(
                    session_turns.input_tokens + session_turns.output_tokens
                    + session_turns.cache_read_tokens + session_turns.cache_write_tokens
                ), 0) AS tokens,
                coalesce(sum(session_turns.total_cost_micros), 0) AS cost_micros
             FROM session_turns
             INNER JOIN models ON models.id = session_turns.model_id
             LEFT JOIN providers ON providers.id = models.provider_id
             ${condition.sql}
             GROUP BY bucket_key, group_id, group_name
             ORDER BY bucket_key`
        )
        .all(bucketSeconds, ...condition.params) as Data[];

    const byBucket = new Map<number, Data & { segments: Data[] }>();
    for (const row of rows) {
        const index = number(row.bucket_key);
        let point = byBucket.get(index);
        if (!point) {
            point = {
                key: formatBucketKey(new Date(index * bucketSeconds * 1000), bucket),
                requests: 0,
                tokens: 0,
                costMicros: 0,
                segments: [],
            };
            byBucket.set(index, point);
        }
        point.requests = number(point.requests) + number(row.requests);
        point.tokens = number(point.tokens) + number(row.tokens);
        point.costMicros = number(point.costMicros) + number(row.cost_micros);
        const id = number(row.group_id);
        point.segments.push({
            groupId: dimension === 'provider' && id === 0 ? null : id,
            name: string(row.group_name) || '—',
            requests: number(row.requests),
            tokens: number(row.tokens),
            costMicros: number(row.cost_micros),
        });
    }
    for (const point of byBucket.values()) {
        point.segments.sort((left, right) => number(right.tokens) - number(left.tokens));
    }
    return { bucket, bucketMs, points: [...byBucket.values()] };
}

function archiveTrend(database: SqliteDatabase) {
    const rows = database
        .prepare(
            `SELECT
                day AS key,
                model_name AS group_name,
                coalesce(sum(request_count), 0) AS requests,
                coalesce(sum(input_tokens + output_tokens + cache_read_tokens
                    + cache_write_tokens), 0) AS tokens,
                coalesce(sum(total_cost_micros), 0) AS cost_micros
             FROM usage_daily_rollups
             GROUP BY day, model_name
             ORDER BY day`
        )
        .all() as Data[];
    const byBucket = new Map<string, Data & { segments: Data[] }>();
    for (const row of rows) {
        const key = string(row.key);
        let point = byBucket.get(key);
        if (!point) {
            point = { key, requests: 0, tokens: 0, costMicros: 0, segments: [] };
            byBucket.set(key, point);
        }
        point.requests = number(point.requests) + number(row.requests);
        point.tokens = number(point.tokens) + number(row.tokens);
        point.costMicros = number(point.costMicros) + number(row.cost_micros);
        point.segments.push({
            groupId: null,
            name: string(row.group_name) || '—',
            requests: number(row.requests),
            tokens: number(row.tokens),
            costMicros: number(row.cost_micros),
        });
    }
    for (const point of byBucket.values()) {
        point.segments.sort((left, right) => number(right.tokens) - number(left.tokens));
    }
    return { bucket: 'day', points: [...byBucket.values()] };
}

function groups(database: SqliteDatabase, filter: UsageFilter, dimension: 'model' | 'provider') {
    const condition = where(filter);
    const join =
        dimension === 'model'
            ? 'INNER JOIN models ON models.id = session_turns.model_id'
            : `INNER JOIN models ON models.id = session_turns.model_id
               INNER JOIN providers ON providers.id = models.provider_id`;
    const id = dimension === 'model' ? 'models.id' : 'providers.id';
    const name = dimension === 'model' ? 'models.name' : 'providers.name';
    const rows = database
        .prepare(
            `SELECT
                ${id} AS id,
                ${name} AS name,
                count(*) AS request_count,
                coalesce(sum(CASE WHEN session_turns.status = 'completed' THEN 1 ELSE 0 END), 0)
                    AS success_count,
                coalesce(sum(session_turns.input_tokens), 0) AS input_tokens,
                coalesce(sum(session_turns.output_tokens), 0) AS output_tokens,
                coalesce(sum(session_turns.cache_read_tokens), 0) AS cache_read_tokens,
                coalesce(sum(session_turns.cache_write_tokens), 0) AS cache_write_tokens,
                coalesce(sum(session_turns.total_cost_micros), 0) AS total_cost_micros,
                coalesce(sum(session_turns.unpriced_calls), 0) AS unpriced_count,
                coalesce(sum(session_turns.ttft_ms), 0) AS sum_ttft,
                count(session_turns.ttft_ms) AS ttft_count,
                coalesce(sum(session_turns.duration_ms), 0) AS sum_duration,
                count(session_turns.duration_ms) AS duration_count
             FROM session_turns
             ${join}
             ${condition.sql}
             GROUP BY ${id}, ${name}
             ORDER BY coalesce(sum(
                session_turns.input_tokens + session_turns.output_tokens
             ), 0) DESC`
        )
        .all(...condition.params) as Data[];
    return rows.map((row) => ({
        id: number(row.id),
        name: string(row.name) || '—',
        requestCount: number(row.request_count),
        successCount: number(row.success_count),
        inputTokens: number(row.input_tokens),
        outputTokens: number(row.output_tokens),
        cacheReadTokens: number(row.cache_read_tokens),
        cacheWriteTokens: number(row.cache_write_tokens),
        totalCostMicros: number(row.total_cost_micros),
        unpricedCount: number(row.unpriced_count),
        meanTtftMs:
            number(row.ttft_count) > 0
                ? Math.round(number(row.sum_ttft) / number(row.ttft_count))
                : null,
        meanDurationMs:
            number(row.duration_count) > 0
                ? Math.round(number(row.sum_duration) / number(row.duration_count))
                : null,
    }));
}

function modelRanking(
    database: SqliteDatabase,
    filter: UsageFilter,
    metric: string,
    limit: number
): Data[] {
    const condition = where(filter);
    const order =
        metric === 'cost'
            ? 'coalesce(sum(session_turns.total_cost_micros), 0)'
            : `coalesce(sum(
                session_turns.input_tokens + session_turns.output_tokens
                + session_turns.cache_read_tokens + session_turns.cache_write_tokens
            ), 0)`;
    const rows = database
        .prepare(
            `SELECT
                models.id AS id,
                models.name AS name,
                count(*) AS requests,
                coalesce(sum(
                    session_turns.input_tokens + session_turns.output_tokens
                    + session_turns.cache_read_tokens + session_turns.cache_write_tokens
                ), 0) AS tokens,
                coalesce(sum(session_turns.total_cost_micros), 0) AS cost_micros,
                coalesce(sum(session_turns.unpriced_calls), 0) AS unpriced_count
             FROM session_turns
             INNER JOIN models ON models.id = session_turns.model_id
             ${condition.sql}
             GROUP BY models.id, models.name
             ORDER BY ${order} DESC
             LIMIT ?`
        )
        .all(...condition.params, Math.max(0, Math.trunc(limit))) as Data[];

    return rows.map((row) => ({
        id: number(row.id),
        name: string(row.name),
        subtitle: null,
        lastAt: null,
        requests: number(row.requests),
        tokens: number(row.tokens),
        costMicros: number(row.cost_micros),
        unpricedCount: number(row.unpriced_count),
        durationMs: null,
    }));
}

function sessionRanking(
    database: SqliteDatabase,
    filter: UsageFilter,
    metric: string,
    limit: number
): Data[] {
    const condition = where(filter);
    const order =
        metric === 'cost'
            ? 'coalesce(sum(session_turns.total_cost_micros), 0)'
            : metric === 'duration'
              ? 'coalesce(sum(session_turns.duration_ms), 0)'
              : `coalesce(sum(
                    session_turns.input_tokens + session_turns.output_tokens
                    + session_turns.cache_read_tokens + session_turns.cache_write_tokens
                ), 0)`;
    const rows = database
        .prepare(
            `SELECT
                sessions.id AS id,
                sessions.title AS title,
                coalesce(max(models.name), '') AS model_name,
                max(session_turns.created_at) AS last_at,
                count(*) AS requests,
                coalesce(sum(
                    session_turns.input_tokens + session_turns.output_tokens
                    + session_turns.cache_read_tokens + session_turns.cache_write_tokens
                ), 0) AS tokens,
                coalesce(sum(session_turns.total_cost_micros), 0) AS cost_micros,
                coalesce(sum(session_turns.unpriced_calls), 0) AS unpriced_count,
                coalesce(sum(session_turns.duration_ms), 0) AS duration_ms
             FROM session_turns
             INNER JOIN sessions ON sessions.id = session_turns.session_id
             LEFT JOIN models ON models.id = session_turns.model_id
             ${condition.sql}
             GROUP BY sessions.id, sessions.title
             ORDER BY ${order} DESC
             LIMIT ?`
        )
        .all(...condition.params, Math.max(0, Math.trunc(limit))) as Data[];

    return rows.map((row) => ({
        id: number(row.id),
        name: string(row.title) || '—',
        subtitle: string(row.model_name) || null,
        lastAt: row.last_at ?? null,
        requests: number(row.requests),
        tokens: number(row.tokens),
        costMicros: number(row.cost_micros),
        unpricedCount: number(row.unpriced_count),
        durationMs: number(row.duration_ms),
    }));
}

function filterOptions(database: SqliteDatabase, filter: UsageFilter): Data {
    const condition = where(filter);
    const models = database
        .prepare(
            `SELECT models.id AS id, models.name AS name, count(*) AS count
             FROM session_turns
             INNER JOIN models ON models.id = session_turns.model_id
             ${condition.sql}
             GROUP BY models.id, models.name
             ORDER BY count(*) DESC`
        )
        .all(...condition.params) as Data[];
    const providers = database
        .prepare(
            `SELECT providers.id AS id, providers.name AS name, count(*) AS count
             FROM session_turns
             INNER JOIN models ON models.id = session_turns.model_id
             INNER JOIN providers ON providers.id = models.provider_id
             ${condition.sql}
             GROUP BY providers.id, providers.name
             ORDER BY count(*) DESC`
        )
        .all(...condition.params) as Data[];
    return {
        models: models.map((row) => ({
            id: number(row.id),
            name: string(row.name),
            count: number(row.count),
        })),
        providers: providers.map((row) => ({
            id: number(row.id),
            name: string(row.name),
            count: number(row.count),
        })),
    };
}

function estimate(chars: number): number {
    return estimateTokensFromChars(chars);
}

function composition(database: SqliteDatabase, filter: UsageFilter): Data {
    const condition = where(filter);
    const turns = database
        .prepare(
            `SELECT
                coalesce(sum(json_extract(prompt_breakdown_json, '$.fragments.platform')), 0)
                    AS platform,
                coalesce(sum(json_extract(prompt_breakdown_json, '$.fragments.policy')), 0)
                    AS policy,
                coalesce(sum(json_extract(prompt_breakdown_json, '$.fragments.mode')), 0)
                    AS mode,
                coalesce(sum(json_extract(prompt_breakdown_json, '$.fragments.feature')), 0)
                    AS feature,
                coalesce(sum(json_extract(prompt_breakdown_json, '$.fragments.agent_profile')), 0)
                    AS agent_profile,
                coalesce(sum(json_extract(prompt_breakdown_json, '$.fragments.session_memory')), 0)
                    AS session_memory,
                coalesce(sum(json_extract(prompt_breakdown_json, '$.fragments.user_append')), 0)
                    AS user_append,
                coalesce(sum(json_extract(prompt_breakdown_json, '$.fragments.override')), 0)
                    AS override,
                coalesce(sum(json_extract(prompt_breakdown_json, '$.builtinToolDefinitions')), 0)
                    AS builtin_tools,
                coalesce(sum(json_extract(prompt_breakdown_json, '$.mcpToolDefinitions')), 0)
                    AS mcp_tools,
                coalesce(sum(json_extract(prompt_breakdown_json, '$.userPrompt')), 0)
                    AS user_prompt,
                coalesce(sum(json_extract(prompt_breakdown_json, '$.attachments')), 0)
                    AS attachments,
                coalesce(sum(output_tokens), 0) AS output_tokens,
                coalesce(sum(input_tokens), 0) AS input_tokens,
                coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens,
                coalesce(sum(duration_ms), 0) AS total_duration_ms
             FROM session_turns${condition.sql}`
        )
        .get(...condition.params) as Data;
    const parts = database
        .prepare(
            `SELECT
                coalesce(sum(CASE WHEN type = 'text' THEN length(content) ELSE 0 END), 0)
                    AS text_chars,
                coalesce(sum(CASE WHEN type = 'reasoning' THEN length(content) ELSE 0 END), 0)
                    AS reasoning_chars,
                coalesce(sum(
                    CASE WHEN type = 'tool_call'
                    THEN length(json_extract(data, '$.output')) ELSE 0 END
                ), 0) AS tool_output_chars
             FROM message_parts
             WHERE created_at BETWEEN ? AND ?`
        )
        .get(filter.from, filter.to) as Data;
    const timing = database
        .prepare(
            `SELECT
                coalesce(sum(CASE WHEN type = 'llm_call'
                    THEN json_extract(data, '$.timing.ttftMs') ELSE 0 END), 0) AS wait,
                coalesce(sum(CASE WHEN type = 'llm_call'
                    AND json_extract(data, '$.timing.firstTextMs') IS NOT NULL
                    AND json_extract(data, '$.timing.ttftMs') IS NOT NULL
                    THEN max(
                        0,
                        json_extract(data, '$.timing.firstTextMs')
                        - json_extract(data, '$.timing.ttftMs')
                    )
                    ELSE 0 END), 0) AS think,
                coalesce(sum(CASE WHEN type = 'llm_call'
                    THEN json_extract(data, '$.timing.flowMs') ELSE 0 END), 0) AS reply,
                coalesce(sum(CASE WHEN type = 'tool_call'
                    THEN json_extract(data, '$.duration_ms') ELSE 0 END), 0) AS tool
             FROM message_parts
             WHERE created_at BETWEEN ? AND ?`
        )
        .get(filter.from, filter.to) as Data;

    const tokenSegments = [
        {
            key: 'systemPrompt',
            value: estimate(number(turns.platform) + number(turns.policy)),
            estimated: true,
        },
        {
            key: 'toolDefinitions',
            value: estimate(number(turns.builtin_tools) + number(turns.mcp_tools)),
            estimated: true,
        },
        {
            key: 'conversation',
            value: estimate(number(parts.text_chars) + number(parts.reasoning_chars)),
            estimated: true,
        },
        {
            key: 'toolResults',
            value: estimate(number(parts.tool_output_chars)),
            estimated: true,
        },
        {
            key: 'userPrompt',
            value: estimate(number(turns.user_prompt)),
            estimated: true,
        },
        {
            key: 'injections',
            value: estimate(
                number(turns.mode) +
                    number(turns.feature) +
                    number(turns.agent_profile) +
                    number(turns.session_memory) +
                    number(turns.user_append) +
                    number(turns.override) +
                    number(turns.attachments)
            ),
            estimated: true,
        },
        { key: 'output', value: number(turns.output_tokens), estimated: false },
    ].filter((segment) => segment.value > 0);

    const totalMs = number(turns.total_duration_ms);
    const wait = number(timing.wait);
    const think = number(timing.think);
    const reply = number(timing.reply);
    const tool = number(timing.tool);
    const other = Math.max(0, totalMs - wait - think - reply - tool);
    const timingSegments = [
        { key: 'wait', value: wait, estimated: false },
        { key: 'think', value: think, estimated: false },
        { key: 'reply', value: reply, estimated: false },
        { key: 'tool', value: tool, estimated: false },
        { key: 'other', value: other, estimated: false },
    ].filter((segment) => segment.value > 0);
    const billingInput = number(turns.input_tokens) + number(turns.cache_read_tokens);

    return {
        tokens: {
            total: tokenSegments.reduce((sum, segment) => sum + segment.value, 0),
            segments: tokenSegments,
        },
        timing: {
            totalMs,
            segments: timingSegments,
        },
        cacheReadShare: billingInput > 0 ? number(turns.cache_read_tokens) / billingInput : 0,
    };
}

function toolStats(database: SqliteDatabase, filter: UsageFilter): Data {
    const rows = database
        .prepare(
            `SELECT
                CASE json_extract(data, '$.toolKind')
                    WHEN 'builtin' THEN 'builtin__' || json_extract(data, '$.tool_id')
                    WHEN 'mcp' THEN 'mcp__'
                        || coalesce(json_extract(data, '$.server_id'), '')
                        || '__'
                        || coalesce(json_extract(data, '$.tool_name'), '')
                    ELSE NULL
                END AS name,
                json_extract(data, '$.toolKind') AS kind,
                json_extract(data, '$.status') AS status,
                count(*) AS count,
                coalesce(sum(json_extract(data, '$.duration_ms')), 0) AS sum_duration,
                count(json_extract(data, '$.duration_ms')) AS duration_count
             FROM message_parts
             WHERE type = 'tool_call'
               AND created_at BETWEEN ? AND ?
             GROUP BY name, kind, status`
        )
        .all(filter.from, filter.to) as Data[];

    const byTool = new Map<
        string,
        {
            name: string;
            kind: 'builtin' | 'mcp';
            count: number;
            errorCount: number;
            sumDuration: number;
            durationCount: number;
        }
    >();
    let totalCount = 0;
    let errorCount = 0;
    let sumDuration = 0;
    let durationCount = 0;

    for (const row of rows) {
        const name = string(row.name) || '—';
        const isError = ['error', 'timeout', 'rejected'].includes(string(row.status));
        const count = number(row.count);
        totalCount += count;
        if (isError) errorCount += count;
        sumDuration += number(row.sum_duration);
        durationCount += number(row.duration_count);

        let entry = byTool.get(name);
        if (!entry) {
            entry = {
                name,
                kind: string(row.kind) === 'mcp' ? 'mcp' : 'builtin',
                count: 0,
                errorCount: 0,
                sumDuration: 0,
                durationCount: 0,
            };
            byTool.set(name, entry);
        }
        entry.count += count;
        if (isError) entry.errorCount += count;
        entry.sumDuration += number(row.sum_duration);
        entry.durationCount += number(row.duration_count);
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
}

function heatmap(database: SqliteDatabase, filter: UsageFilter): Data[] {
    const condition = where(filter);
    return database
        .prepare(
            `SELECT
                date(session_turns.created_at, 'localtime') AS day,
                cast(strftime('%H', session_turns.created_at, 'localtime') AS integer) AS hour,
                count(*) AS requests,
                coalesce(sum(
                    session_turns.input_tokens + session_turns.output_tokens
                    + session_turns.cache_read_tokens + session_turns.cache_write_tokens
                ), 0) AS tokens,
                coalesce(sum(session_turns.total_cost_micros), 0) AS cost_micros
             FROM session_turns${condition.sql}
             GROUP BY day, hour
             ORDER BY day, hour`
        )
        .all(...condition.params) as Data[];
}

type RawTurnSample = {
    turnId: number;
    createdAt: string;
    modelId: number;
    modelName: string;
    window: number;
    promptTokens: number;
    cacheReadTokens: number;
    inputTokens: number;
    breakdown: string | null;
    failed: boolean;
};

function loadContextSamples(database: SqliteDatabase, filter: UsageFilter): RawTurnSample[] {
    const condition = where(filter, 'session_turns.prompt_breakdown_json IS NOT NULL');
    const rows = database
        .prepare(
            `SELECT
                session_turns.id AS turn_id,
                session_turns.created_at AS created_at,
                session_turns.model_id AS model_id,
                models.name AS model_name,
                coalesce(models.context_limit, 0) AS window,
                (
                    session_turns.input_tokens
                    + session_turns.cache_read_tokens
                    + session_turns.cache_write_tokens
                ) AS prompt_tokens,
                session_turns.cache_read_tokens AS cache_read_tokens,
                session_turns.input_tokens AS input_tokens,
                session_turns.prompt_breakdown_json AS breakdown,
                CASE WHEN session_turns.status = 'failed' THEN 1 ELSE 0 END AS failed
             FROM session_turns
             INNER JOIN models ON models.id = session_turns.model_id
             ${condition.sql}
             ORDER BY session_turns.created_at DESC, session_turns.id DESC
             LIMIT ?`
        )
        .all(...condition.params, SAMPLE_LIMIT) as Data[];
    return rows.map((row) => ({
        turnId: number(row.turn_id),
        createdAt: string(row.created_at),
        modelId: number(row.model_id),
        modelName: string(row.model_name),
        window: number(row.window),
        promptTokens: number(row.prompt_tokens),
        cacheReadTokens: number(row.cache_read_tokens),
        inputTokens: number(row.input_tokens),
        breakdown: typeof row.breakdown === 'string' ? row.breakdown : null,
        failed: number(row.failed) === 1,
    }));
}

function percentile(sorted: readonly number[], ratio: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
    return sorted[index] ?? 0;
}

function median(sorted: readonly number[]): number {
    if (sorted.length === 0) return 0;
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function scoreContext(input: {
    cacheReuseRate: number;
    cacheKnown: boolean;
    baselineMedian: number;
    window: number;
    growthMedian: number;
    errorRate: number;
}): { score: number; scores: Data[] } {
    const window = Math.max(input.window, 1);
    const cache = input.cacheKnown ? clamp01(input.cacheReuseRate / 0.9) : 0.5;
    const lean = clamp01(1 - (input.baselineMedian / window - 0.05) / 0.25);
    const pace = clamp01(1 - (input.growthMedian / window - 0.01) / 0.05);
    const reliable = clamp01(1 - input.errorRate / 0.2);
    const scores = [
        { key: 'cache', points: Math.round(cache * 35), most: 35 },
        { key: 'lean', points: Math.round(lean * 25), most: 25 },
        { key: 'pace', points: Math.round(pace * 20), most: 20 },
        { key: 'reliable', points: Math.round(reliable * 20), most: 20 },
    ];
    return { score: scores.reduce((sum, part) => sum + part.points, 0), scores };
}

function buildTags(input: {
    cacheReuseRate: number;
    cacheKnown: boolean;
    baselineMedian: number;
    mcpToolTokens: number;
    window: number;
    growthMedian: number;
    peakFill: number;
    compactCount: number;
    turnCount: number;
    errorRate: number;
    attachmentShare: number;
    userPromptShare: number;
}): Data[] {
    const tags: Data[] = [];
    const window = Math.max(input.window, 1);
    if (input.cacheKnown && input.cacheReuseRate >= 0.8) {
        tags.push({ key: 'cacheFriendly', tone: 'good' });
    }
    if (input.cacheKnown && input.cacheReuseRate < 0.4 && input.turnCount >= 5) {
        tags.push({ key: 'cacheMisses', tone: 'warn' });
    }
    if (input.baselineMedian / window <= 0.06) {
        tags.push({ key: 'lean', tone: 'good' });
    }
    if (input.baselineMedian / window >= 0.2) {
        tags.push({ key: 'heavyStart', tone: 'warn' });
    }
    if (input.mcpToolTokens >= 5_000 && input.mcpToolTokens >= input.baselineMedian * 0.3) {
        tags.push({ key: 'mcpHeavy', tone: 'info' });
    }
    if (input.growthMedian / window >= 0.03) {
        tags.push({ key: 'fillsFast', tone: 'warn' });
    }
    if (input.peakFill >= 0.85) {
        tags.push({ key: 'nearFull', tone: 'warn' });
    }
    if (input.compactCount > 0) {
        tags.push({ key: 'compacts', tone: 'info' });
    }
    if (input.attachmentShare >= 0.15) {
        tags.push({ key: 'attachmentHeavy', tone: 'info' });
    }
    if (input.userPromptShare >= 0.3) {
        tags.push({ key: 'promptBloat', tone: 'info' });
    }
    if (input.turnCount >= 20 && input.errorRate < 0.01) {
        tags.push({ key: 'steady', tone: 'good' });
    }
    if (input.turnCount >= 5 && input.errorRate >= 0.1) {
        tags.push({ key: 'flaky', tone: 'warn' });
    }
    return tags;
}

function contextProfile(
    samples: readonly RawTurnSample[],
    modelId: number | null,
    modelName: string
): Data | null {
    if (samples.length === 0) return null;
    const prompts = samples.map((sample) => sample.promptTokens).sort((a, b) => a - b);
    const promptMedian = median(prompts);
    const promptP90 = percentile(prompts, 0.9);
    const peak = prompts[prompts.length - 1] ?? 0;
    const windows = samples.map((sample) => sample.window).filter((value) => value > 0);
    const window = windows.length > 0 ? Math.max(...windows) : 0;

    const baselines: number[] = [];
    const shareTotals = new Map<string, number>();
    let userPromptChars = 0;
    let totalChars = 0;
    for (const sample of samples) {
        const parsed = parsePromptBreakdown(sample.breakdown);
        if (!parsed) continue;
        baselines.push(
            estimate(
                parsed.systemPromptTotal + parsed.builtinToolDefinitions + parsed.mcpToolDefinitions
            )
        );
        const conversationChars = Math.max(
            0,
            parsed.systemPromptTotal - sumFragmentChars(parsed.fragments)
        );
        const segments: Record<string, number> = {
            systemPrompt: sumFragmentChars(parsed.fragments),
            builtinToolDefinitions: parsed.builtinToolDefinitions,
            mcpToolDefinitions: parsed.mcpToolDefinitions,
            conversation: conversationChars,
            userPrompt: parsed.userPrompt,
            attachments: parsed.attachments,
        };
        let sampleTotal = 0;
        for (const [key, chars] of Object.entries(segments)) {
            shareTotals.set(key, (shareTotals.get(key) ?? 0) + chars);
            sampleTotal += chars;
        }
        totalChars += sampleTotal;
        userPromptChars += parsed.userPrompt;
    }
    baselines.sort((a, b) => a - b);
    const baselineMedian = baselines.length > 0 ? percentile(baselines, 0.5) : 0;

    const chronological = [...samples].sort((a, b) => a.turnId - b.turnId);
    const growth: number[] = [];
    let compactCount = 0;
    for (let index = 1; index < chronological.length; index += 1) {
        const previous = chronological[index - 1]!;
        const current = chronological[index]!;
        if (previous.modelId !== current.modelId) continue;
        const delta = current.promptTokens - previous.promptTokens;
        if (delta > 0) growth.push(delta);
        if (
            previous.promptTokens >= COMPACTION_MIN_TOKENS &&
            current.promptTokens < previous.promptTokens * COMPACTION_RATIO
        ) {
            compactCount += 1;
        }
    }
    growth.sort((a, b) => a - b);
    const growthMedian = growth.length > 0 ? percentile(growth, 0.5) : 0;
    const cacheReadTotal = samples.reduce((sum, sample) => sum + sample.cacheReadTokens, 0);
    const inputTotal = samples.reduce((sum, sample) => sum + sample.inputTokens, 0);
    const cacheKnown = cacheReadTotal > 0;
    const cacheReuseRate =
        cacheReadTotal + inputTotal > 0 ? cacheReadTotal / (cacheReadTotal + inputTotal) : 0;
    const failures = samples.filter((sample) => sample.failed).length;
    const errorRate = samples.length > 0 ? failures / samples.length : 0;
    const shares = SHARE_ORDER.map((key) => {
        const chars = shareTotals.get(key) ?? 0;
        return {
            key,
            tokens: estimate(chars),
            share: totalChars > 0 ? chars / totalChars : 0,
        };
    });
    const { score, scores } = scoreContext({
        cacheReuseRate,
        cacheKnown,
        baselineMedian,
        window,
        growthMedian,
        errorRate,
    });
    const tags = buildTags({
        cacheReuseRate,
        cacheKnown,
        baselineMedian,
        mcpToolTokens: shareTotals.get('mcpToolDefinitions') ?? 0,
        window,
        growthMedian,
        peakFill: window > 0 ? peak / window : 0,
        compactCount,
        turnCount: samples.length,
        errorRate,
        attachmentShare: totalChars > 0 ? (shareTotals.get('attachments') ?? 0) / totalChars : 0,
        userPromptShare: totalChars > 0 ? userPromptChars / totalChars : 0,
    });
    return {
        modelId,
        modelName,
        window,
        turnCount: samples.length,
        promptMedian,
        promptP90,
        baselineMedian,
        growthMedian,
        peakFill: window > 0 ? peak / window : 0,
        cacheReuseRate,
        compactCount,
        errorRate,
        shares,
        score,
        scores,
        tags,
    };
}

function contextProfiles(database: SqliteDatabase, filter: UsageFilter): Data {
    const samples = loadContextSamples(database, filter);
    if (samples.length === 0) return { overall: null, models: [] };
    const overall = contextProfile(samples, null, '');
    const byModel = new Map<number, RawTurnSample[]>();
    for (const sample of samples) {
        const bucket = byModel.get(sample.modelId);
        if (bucket) bucket.push(sample);
        else byModel.set(sample.modelId, [sample]);
    }
    const models = [...byModel.entries()]
        .map(([modelId, modelSamples]) =>
            contextProfile(modelSamples, modelId, modelSamples[0]?.modelName ?? '')
        )
        .filter((profile): profile is Data => profile !== null)
        .sort((left, right) => number(right.turnCount) - number(left.turnCount));
    return { overall, models };
}

function contextPoints(database: SqliteDatabase, filter: UsageFilter, limit: number): Data[] {
    const samples = loadContextSamples(database, filter);
    if (samples.length === 0 || limit <= 0) return [];
    const chronological = [...samples].sort((a, b) => a.turnId - b.turnId);
    const points = chronological.map((sample, index) => {
        const previous = index > 0 ? chronological[index - 1]! : null;
        const isCompaction =
            previous !== null &&
            previous.modelId === sample.modelId &&
            previous.promptTokens >= COMPACTION_MIN_TOKENS &&
            sample.promptTokens < previous.promptTokens * COMPACTION_RATIO;
        return {
            turnId: sample.turnId,
            createdAt: sample.createdAt,
            modelId: sample.modelId,
            promptTokens: sample.promptTokens,
            window: sample.window,
            fillRate: sample.window > 0 ? sample.promptTokens / sample.window : 0,
            cacheReadTokens: sample.cacheReadTokens,
            isCompaction,
        };
    });
    return points.slice(-Math.trunc(limit));
}

function appendLlmCallParts(database: SqliteDatabase, messageId: number, calls: Data[]): number {
    if (calls.length === 0) return 0;
    const maxRow = database
        .prepare(
            'SELECT coalesce(max(sort_order), -1) AS value FROM message_parts WHERE message_id = ?'
        )
        .get(messageId) as Data | undefined;
    const baseOrder = number(maxRow?.value) + 1;
    const insert = database.prepare(
        `INSERT INTO message_parts (
            message_id, type, content, data, started_at, ended_at, sort_order
        ) VALUES (?, 'llm_call', '', ?, ?, ?, ?)`
    );
    database.exec('BEGIN IMMEDIATE');
    try {
        for (const [index, call] of calls.entries()) {
            insert.run(
                messageId,
                String(call.data ?? ''),
                call.startedAt === undefined || call.startedAt === null
                    ? null
                    : Number(call.startedAt),
                call.endedAt === undefined || call.endedAt === null ? null : Number(call.endedAt),
                baseOrder + index
            );
        }
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
    return calls.length;
}

function normalizedRetentionDays(retentionDays: unknown): number | null {
    if (
        typeof retentionDays !== 'number' ||
        !Number.isFinite(retentionDays) ||
        retentionDays <= 0
    ) {
        return null;
    }
    return Math.floor(retentionDays);
}

function pruneDetail(database: SqliteDatabase, retentionDays: unknown): number {
    const days = normalizedRetentionDays(retentionDays);
    if (days === null) return 0;
    return (
        database
            .prepare(
                `DELETE FROM message_parts
                 WHERE type = 'llm_call'
                   AND created_at < datetime('now', ?)
                 RETURNING id`
            )
            .all(`-${days} days`) as Data[]
    ).length;
}

function maintenance(
    database: SqliteDatabase,
    retentionDays: unknown,
    minIntervalMs: unknown,
    now: unknown,
    statisticKey: unknown
): Data {
    const key = String(statisticKey ?? '');
    if (!key.trim()) throw new Error('Usage maintenance statistic key must not be empty');
    const nowText = String(now ?? '');
    const nowMs = Date.parse(nowText);
    if (!Number.isFinite(nowMs)) throw new Error('Usage maintenance timestamp is invalid');
    const interval = Number(minIntervalMs ?? 0);
    const lastRun = database
        .prepare('SELECT value FROM statistics WHERE key = ? LIMIT 1')
        .get(key) as Data | undefined;
    const lastRunMs = lastRun ? Date.parse(string(lastRun.value)) : Number.NaN;
    const due = !Number.isFinite(lastRunMs) || nowMs - lastRunMs >= interval;
    if (!due) return { ran: false, pruned: 0 };

    database.exec('BEGIN IMMEDIATE');
    try {
        database.prepare(ROLLUP_SQL).run();
        const pruned = pruneDetail(database, retentionDays);
        database
            .prepare(
                `INSERT INTO statistics (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
            )
            .run(key, nowText);
        database.exec('COMMIT');
        return { ran: true, pruned };
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

export function routeUsageOperation(
    database: SqliteDatabase,
    request: OperationRequest
): { value: unknown } | undefined {
    const filter = request.filter as UsageFilter | undefined;
    switch (request.kind) {
        case 'usage_summary':
            return { value: summary(database, filter!) };
        case 'usage_dashboard':
            return {
                value: {
                    summary: summary(database, filter!),
                    liveTurns: dashboardLiveTurns(
                        database,
                        filter!,
                        (request.taskIds as string[] | undefined) ?? []
                    ),
                    trend: trend(
                        database,
                        filter!,
                        request.dimension === 'provider' ? 'provider' : 'model'
                    ),
                },
            };
        case 'usage_trend':
            return {
                value: trend(
                    database,
                    filter!,
                    request.dimension === 'provider' ? 'provider' : 'model'
                ),
            };
        case 'usage_archive_trend':
            return { value: archiveTrend(database) };
        case 'usage_by_model':
            return { value: groups(database, filter!, 'model') };
        case 'usage_by_provider':
            return { value: groups(database, filter!, 'provider') };
        case 'usage_model_ranking':
            return {
                value: modelRanking(
                    database,
                    filter!,
                    string(request.metric),
                    number(request.limit)
                ),
            };
        case 'usage_session_ranking':
            return {
                value: sessionRanking(
                    database,
                    filter!,
                    string(request.metric),
                    number(request.limit)
                ),
            };
        case 'usage_filter_options':
            return { value: filterOptions(database, filter!) };
        case 'usage_composition':
            return { value: composition(database, filter!) };
        case 'usage_tool_stats':
            return { value: toolStats(database, filter!) };
        case 'usage_heatmap':
            return { value: heatmap(database, filter!) };
        case 'usage_context_profiles':
            return { value: contextProfiles(database, filter!) };
        case 'usage_context_points':
            return {
                value: contextPoints(database, filter!, number(request.limit)),
            };
        case 'usage_append_llm_call_parts':
            return {
                value: appendLlmCallParts(
                    database,
                    number(request.messageId),
                    (request.calls as Data[] | undefined) ?? []
                ),
            };
        case 'usage_rollup_daily':
            database.exec('BEGIN IMMEDIATE');
            try {
                database.prepare(ROLLUP_SQL).run();
                database.exec('COMMIT');
            } catch (error) {
                database.exec('ROLLBACK');
                throw error;
            }
            return { value: null };
        case 'usage_prune_detail':
            return { value: pruneDetail(database, request.retentionDays) };
        case 'usage_maintenance':
            return {
                value: maintenance(
                    database,
                    request.retentionDays,
                    request.minIntervalMs,
                    request.now,
                    request.statisticKey
                ),
            };
        default:
            return undefined;
    }
}

function dashboardLiveTurns(
    database: SqliteDatabase,
    filter: UsageFilter,
    taskIds: string[]
): Data[] {
    if (taskIds.length === 0) return [];
    const condition = where(filter, `session_turns.task_id IN (${placeholders(taskIds.length)})`);
    const rows = database
        .prepare(
            `SELECT
                session_turns.task_id AS task_id,
                session_turns.created_at AS created_at,
                session_turns.status AS status,
                session_turns.output_tokens AS output_tokens,
                session_turns.total_cost_micros AS total_cost_micros,
                session_turns.duration_ms AS duration_ms
             FROM session_turns${condition.sql}
             ORDER BY session_turns.created_at, session_turns.id`
        )
        .all(...condition.params, ...taskIds) as Data[];
    return rows.map((row) => ({
        taskId: string(row.task_id),
        createdAt: string(row.created_at),
        status: string(row.status),
        outputTokens: number(row.output_tokens),
        totalCostMicros: number(row.total_cost_micros),
        durationMs: row.duration_ms === null ? null : number(row.duration_ms),
    }));
}
