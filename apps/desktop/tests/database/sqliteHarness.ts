import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import { interceptTauriInvoke } from '@tests/utils/tauri';

import { expandModelIdCandidates } from '@/domain/models/modelIdCandidates';

import { routeUsageOperation } from './usageHarness';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');

const databaseRoot = resolve('src/database');
const journal = JSON.parse(readFileSync(`${databaseRoot}/drizzle/meta/_journal.json`, 'utf8')) as {
    entries: Array<{ tag: string }>;
};
const openDatabases: SqliteDatabase[] = [];
const beforeCommitHooks = new WeakMap<SqliteDatabase, (() => void) | undefined>();

type Data = Record<string, unknown>;
type OperationRequest = Data & { kind: string };

/**
 * Opens an in-memory SQLite database with every shipped migration applied, so the
 * tests exercise the real schema instead of a hand-written subset.
 *
 * Call `closeTestDatabases()` in `afterEach` to release them.
 */
export function openMigratedDatabase(): SqliteDatabase {
    const database = new DatabaseSync(':memory:');
    openDatabases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    for (const entry of journal.entries) {
        database.exec(readFileSync(`${databaseRoot}/drizzle/${entry.tag}.sql`, 'utf8'));
    }
    return database;
}

/**
 * Routes the app's database IPC to a real in-memory database.
 *
 * The query layer only ever talks to SQLite through Tauri commands, so this is the
 * system boundary the tests replace; everything above it runs for real.
 */
export function routeQueriesTo(
    database: SqliteDatabase,
    options: { beforeCommit?: () => void } = {}
): void {
    beforeCommitHooks.set(database, options.beforeCommit);
    interceptTauriInvoke((call, next) => {
        const operation = routeDatabaseOperation(database, call);
        if (operation) {
            return operation.value;
        }
        return next();
    });
}

function sqlValue(value: unknown): SQLInputValue {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
        return value;
    }
    return JSON.stringify(value);
}

function insertRow(
    database: SqliteDatabase,
    table: string,
    data: Data,
    mode = 'INSERT'
): Record<string, unknown> | undefined {
    const keys = Object.keys(data);
    const columns = keys.map((key) => `"${key}"`).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    return database
        .prepare(`${mode} INTO ${table} (${columns}) VALUES (${placeholders}) RETURNING *`)
        .get(...keys.map((key) => sqlValue(data[key]))) as Record<string, unknown> | undefined;
}

function updateById(
    database: SqliteDatabase,
    table: string,
    id: number,
    data: Data
): Record<string, unknown> | undefined {
    const keys = Object.keys(data);
    const assignments = keys.map((key) => `"${key}" = ?`).join(', ');
    return database
        .prepare(`UPDATE ${table} SET ${assignments} WHERE id = ? RETURNING *`)
        .get(...keys.map((key) => sqlValue(data[key])), id) as Record<string, unknown> | undefined;
}

function transaction<T>(database: SqliteDatabase, callback: () => T): T {
    database.exec('BEGIN IMMEDIATE');
    try {
        const result = callback();
        beforeCommitHooks.get(database)?.();
        database.exec('COMMIT');
        return result;
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

function toolPartPayload(data: Data): Data {
    const payload = { ...data };
    delete payload.message_id;
    delete payload.session_id;
    delete payload.tool_call_id;
    delete payload.created_at;
    if (typeof data.tool_call_id === 'string') payload.toolCallId = data.tool_call_id;
    return payload;
}

function toolPartFilter(request: OperationRequest): { clause: string; params: SQLInputValue[] } {
    const filter = request.filter as Data;
    switch (filter.kind) {
        case 'id':
            return { clause: 'message_parts.id = ?', params: [Number(filter.id)] };
        case 'tool_call_id':
            return {
                clause: 'message_parts.tool_call_id = ?',
                params: [String(filter.toolCallId)],
            };
        case 'server_id':
            return {
                clause: 'message_parts.server_id = ?',
                params: [Number(filter.serverId)],
            };
        case 'tool_id':
            return {
                clause: 'message_parts.tool_id = ?',
                params: [String(filter.toolId)],
            };
        default:
            throw new Error(`Unsupported tool part filter: ${String(filter.kind)}`);
    }
}

function createToolPartOperation(database: SqliteDatabase, request: OperationRequest): Data {
    const input = request.data as Data;
    const messageId =
        typeof input.message_id === 'number' && input.message_id > 0
            ? input.message_id
            : insertRow(database, 'messages', {
                  session_id: input.session_id,
                  role: 'tool_call',
              })?.id;
    if (typeof messageId !== 'number') {
        throw Object.assign(new Error('A tool call must belong to a session'), {
            code: 'database-validation',
        });
    }

    const kind = String(request.toolKind);
    const payload: Data = {
        iteration: 1,
        output: null,
        status: 'pending',
        duration_ms: null,
        error_message: null,
        ...(kind === 'builtin'
            ? {
                  approval_state: 'none',
                  approval_summary: null,
                  conversation_semantic_json: null,
                  structured_payload_json: null,
              }
            : {}),
        ...toolPartPayload(input),
        toolKind: kind,
    };
    const created = insertRow(database, 'message_parts', {
        message_id: messageId,
        type: 'tool_call',
        content: '',
        sort_order: Number(
            database
                .prepare(
                    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM message_parts WHERE message_id = ?'
                )
                .get(messageId)?.value
        ),
        data: JSON.stringify(payload),
        ...(typeof input.created_at === 'string' ? { created_at: input.created_at } : {}),
    });
    const parent = database
        .prepare('SELECT session_id FROM messages WHERE id = ?')
        .get(messageId) as Data | undefined;
    if (!created || !parent) {
        throw Object.assign(new Error('Failed to persist tool part'), {
            code: 'database-unavailable',
        });
    }
    return {
        ...(JSON.parse(String(created.data)) as Data),
        id: created.id,
        tool_call_id: created.tool_call_id ?? null,
        session_id: parent.session_id,
        message_id: created.message_id,
        created_at: created.created_at,
    };
}

const BUILTIN_PROVIDER_ORDER = new Map(
    [
        'OpenAI',
        'Anthropic',
        'Gemini',
        'Xiaomi MiMo',
        'DeepSeek',
        '火山引擎',
        'Grok',
        '腾讯混元',
        'MiniMax',
        '月之暗面',
        '阿里云百炼',
        '智谱',
    ].map((name, index) => [name, index])
);

function providerOrder(provider: Data): number {
    if (provider.is_builtin !== 1) return Number.MAX_SAFE_INTEGER;
    return BUILTIN_PROVIDER_ORDER.get(String(provider.name)) ?? Number.MAX_SAFE_INTEGER - 1;
}

const MODEL_WITH_PROVIDER = `
    SELECT
        models.id, models.created_at, models.updated_at, models.provider_id,
        models.model_id, models.name, models.is_default, models.last_used_at,
        models.attachment, models.modalities, models.open_weights, models.reasoning,
        models.reasoning_options, models.release_date, models.temperature, models.tool_call,
        models.knowledge, models.context_limit, models.output_limit,
        models.is_custom_metadata, models.upstream_metadata,
        providers.name AS provider_name, providers.driver AS provider_driver,
        providers.api_endpoint AS api_endpoint, providers.api_key AS api_key,
        providers.config_json AS provider_config_json, providers.enabled AS provider_enabled,
        providers.logo AS provider_logo
    FROM models
    INNER JOIN providers ON providers.id = models.provider_id
`;

const SESSION_SELECT = `
    SELECT
        sessions.*,
        CASE
            WHEN (
                SELECT latest_session_turns.status
                FROM session_turns latest_session_turns
                WHERE latest_session_turns.session_id = sessions.id
                ORDER BY latest_session_turns.created_at DESC, latest_session_turns.id DESC
                LIMIT 1
            ) IN ('completed', 'failed')
            AND COALESCE((
                SELECT latest_session_turns.id
                FROM session_turns latest_session_turns
                WHERE latest_session_turns.session_id = sessions.id
                ORDER BY latest_session_turns.created_at DESC, latest_session_turns.id DESC
                LIMIT 1
            ), 0) > COALESCE(sessions.status_badge_dismissed_turn_id, 0)
            THEN (
                SELECT latest_session_turns.status
                FROM session_turns latest_session_turns
                WHERE latest_session_turns.session_id = sessions.id
                ORDER BY latest_session_turns.created_at DESC, latest_session_turns.id DESC
                LIMIT 1
            )
            ELSE NULL
        END AS pending_terminal_status
    FROM sessions
`;

function messageTextSql(messageAlias: string): string {
    return `COALESCE((
        SELECT group_concat(content, '') FROM (
            SELECT CASE
                WHEN part.type = 'text' THEN part.content
                ELSE COALESCE(json_extract(part.data, '$.output'), '')
            END AS content
            FROM message_parts part
            WHERE part.message_id = ${messageAlias}.id
              AND part.type IN ('text', 'tool_call')
            ORDER BY part.sort_order, part.id
        )
    ), '')`;
}

function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, '\\$&');
}

function buildSessionSearchTrigramExpression(query: string): string | null {
    if (query.includes('\0')) return null;
    const characters = Array.from(query);
    if (characters.length < 3) return null;

    const starts = new Set([0, characters.length - 3]);
    if (characters.length >= 9) {
        starts.add(Math.floor((characters.length - 3) / 2));
    }

    const tokens: string[] = [];
    const seen = new Set<string>();
    for (const start of [...starts].sort((left, right) => left - right)) {
        if (tokens.length >= 3) break;
        const token = characters.slice(start, start + 3).join('');
        if (token.length !== 3 || seen.has(token)) continue;
        seen.add(token);
        tokens.push(token);
    }

    return tokens.length
        ? tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ')
        : null;
}

function normalizeSessionLimit(limit: unknown): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) return 40;
    return Math.max(1, Math.min(Math.trunc(limit), 1000));
}

const UPSTREAM_METADATA_SQL = `
    WITH upstream_model_metadata AS (
        SELECT
            json_extract(entry.value, '$.model_id') AS model_id,
            json_extract(entry.value, '$.metadata') AS metadata
        FROM json_each(?) AS entry
    )
    UPDATE models
    SET
        upstream_metadata = json_patch(
            COALESCE(upstream_metadata, '{}'),
            COALESCE((
                SELECT upstream_model_metadata.metadata
                FROM upstream_model_metadata
                WHERE upstream_model_metadata.model_id = models.model_id
            ), '{}')
        ),
        updated_at = datetime('now')
    WHERE provider_id = ?
      AND is_custom_metadata = 0
      AND EXISTS (
        SELECT 1 FROM upstream_model_metadata
        WHERE upstream_model_metadata.model_id = models.model_id
      )
`;

function metadataRichness(record: Data): number {
    return (
        Number(record.attachment) +
        Number(record.open_weights) +
        Number(record.reasoning) +
        Number(record.temperature) +
        Number(record.tool_call) +
        (String(record.modalities ?? '').length > 0 ? 1 : 0)
    );
}

function parseLimit(limit: unknown): { context: number | null; output: number | null } {
    if (typeof limit !== 'string') return { context: null, output: null };
    try {
        const parsed = JSON.parse(limit) as Data;
        return {
            context: typeof parsed.context === 'number' ? parsed.context : null,
            output: typeof parsed.output === 'number' ? parsed.output : null,
        };
    } catch {
        return { context: null, output: null };
    }
}

function parseUpstreamMetadata(value: unknown): Data | null {
    if (typeof value !== 'string') return null;
    try {
        const parsed = JSON.parse(value) as unknown;
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Data)
            : null;
    } catch {
        return null;
    }
}

function resolveMetadataRow(target: Data, metadata: Data | undefined): Data | null {
    const upstream = parseUpstreamMetadata(target.upstream_metadata);
    if (!upstream && !metadata) return null;
    const clearReasoningOptions = upstream?.reasoning === 0 ? 1 : 0;
    const limits = parseLimit(metadata?.limit);
    return {
        id: target.id,
        attachment: upstream?.attachment ?? metadata?.attachment ?? null,
        modalities: upstream?.modalities ?? metadata?.modalities ?? null,
        open_weights: metadata?.open_weights ?? null,
        reasoning: upstream?.reasoning ?? metadata?.reasoning ?? null,
        reasoning_options: clearReasoningOptions
            ? null
            : (upstream?.reasoning_options ?? metadata?.reasoning_options ?? null),
        release_date: metadata?.release_date ?? null,
        temperature: metadata?.temperature ?? null,
        tool_call: upstream?.tool_call ?? metadata?.tool_call ?? null,
        knowledge: metadata?.knowledge ?? null,
        context_limit: upstream?.context_limit ?? limits.context,
        output_limit: upstream?.output_limit ?? limits.output,
        clear_reasoning_options: clearReasoningOptions,
    };
}

function syncAllModelsMetadata(database: SqliteDatabase): void {
    const targets = database
        .prepare('SELECT id, model_id, upstream_metadata FROM models WHERE is_custom_metadata = 0')
        .all() as Data[];
    if (targets.length === 0) return;

    const candidates = new Set<string>();
    for (const target of targets) {
        for (const { candidate } of expandModelIdCandidates(String(target.model_id))) {
            candidates.add(candidate);
        }
    }
    const aliases = database
        .prepare('SELECT alias, model_id FROM llm_metadata_aliases')
        .all() as Data[];
    const aliasTargets = new Map(
        aliases
            .filter((row) => candidates.has(String(row.alias)))
            .map((row) => [String(row.alias), String(row.model_id)])
    );
    if (aliasTargets.size === 0) return;

    const metadataRows = database
        .prepare(
            `SELECT model_id, attachment, modalities, open_weights, reasoning, reasoning_options,
                    release_date, temperature, tool_call, knowledge, "limit"
             FROM llm_metadata`
        )
        .all() as Data[];
    const metadataByModel = new Map(metadataRows.map((row) => [String(row.model_id), row]));

    const updates: Data[] = [];
    for (const target of targets) {
        let best:
            | { depth: number; metadata: Data; richness: number; length: number; modelId: string }
            | undefined;
        for (const { candidate, depth } of expandModelIdCandidates(String(target.model_id))) {
            const metadataModelId = aliasTargets.get(candidate);
            const metadata = metadataModelId ? metadataByModel.get(metadataModelId) : undefined;
            if (!metadata) continue;
            const ranked = {
                depth,
                metadata,
                richness: metadataRichness(metadata),
                length: metadataModelId!.length,
                modelId: metadataModelId!,
            };
            if (
                !best ||
                ranked.depth < best.depth ||
                (ranked.depth === best.depth && ranked.richness > best.richness) ||
                (ranked.depth === best.depth &&
                    ranked.richness === best.richness &&
                    ranked.length > best.length) ||
                (ranked.depth === best.depth &&
                    ranked.richness === best.richness &&
                    ranked.length === best.length &&
                    ranked.modelId < best.modelId)
            ) {
                best = ranked;
            }
        }
        const row = resolveMetadataRow(target, best?.metadata);
        if (row) updates.push(row);
    }
    if (updates.length === 0) return;

    database
        .prepare(
            `WITH selected_model_metadata AS (
                SELECT
                    json_extract(entry.value, '$.id') AS model_row_id,
                    json_extract(entry.value, '$.attachment') AS attachment,
                    json_extract(entry.value, '$.modalities') AS modalities,
                    json_extract(entry.value, '$.open_weights') AS open_weights,
                    json_extract(entry.value, '$.reasoning') AS reasoning,
                    json_extract(entry.value, '$.reasoning_options') AS reasoning_options,
                    json_extract(entry.value, '$.release_date') AS release_date,
                    json_extract(entry.value, '$.temperature') AS temperature,
                    json_extract(entry.value, '$.tool_call') AS tool_call,
                    json_extract(entry.value, '$.knowledge') AS knowledge,
                    json_extract(entry.value, '$.context_limit') AS context_limit,
                    json_extract(entry.value, '$.output_limit') AS output_limit,
                    json_extract(entry.value, '$.clear_reasoning_options') AS clear_reasoning_options
                FROM json_each(?) AS entry
            )
            UPDATE models
            SET
                attachment = COALESCE((SELECT attachment FROM selected_model_metadata WHERE model_row_id = models.id), attachment),
                modalities = COALESCE((SELECT modalities FROM selected_model_metadata WHERE model_row_id = models.id), modalities),
                open_weights = COALESCE((SELECT open_weights FROM selected_model_metadata WHERE model_row_id = models.id), open_weights),
                reasoning = COALESCE((SELECT reasoning FROM selected_model_metadata WHERE model_row_id = models.id), reasoning),
                reasoning_options = CASE
                    WHEN (SELECT clear_reasoning_options FROM selected_model_metadata WHERE model_row_id = models.id) = 1 THEN NULL
                    ELSE COALESCE((SELECT reasoning_options FROM selected_model_metadata WHERE model_row_id = models.id), reasoning_options)
                END,
                release_date = COALESCE((SELECT release_date FROM selected_model_metadata WHERE model_row_id = models.id), release_date),
                temperature = COALESCE((SELECT temperature FROM selected_model_metadata WHERE model_row_id = models.id), temperature),
                tool_call = COALESCE((SELECT tool_call FROM selected_model_metadata WHERE model_row_id = models.id), tool_call),
                knowledge = COALESCE((SELECT knowledge FROM selected_model_metadata WHERE model_row_id = models.id), knowledge),
                context_limit = COALESCE((SELECT context_limit FROM selected_model_metadata WHERE model_row_id = models.id), context_limit),
                output_limit = COALESCE((SELECT output_limit FROM selected_model_metadata WHERE model_row_id = models.id), output_limit),
                updated_at = datetime('now')
            WHERE is_custom_metadata = 0
              AND EXISTS (SELECT 1 FROM selected_model_metadata WHERE model_row_id = models.id)`
        )
        .run(JSON.stringify(updates));
}

function upsertStatistic(database: SqliteDatabase, key: string, value: string): void {
    database
        .prepare(
            `INSERT INTO statistics (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(key, value);
}

function parseTiers(raw: unknown): Data[] {
    if (typeof raw !== 'string') return [];
    try {
        const parsed = JSON.parse(raw) as Data[];
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((tier) => typeof tier.above === 'number' && tier.above > 0)
            .sort((left, right) => Number(left.above) - Number(right.above))
            .map((tier) => ({
                above: tier.above,
                inputPerMillion: tier.input == null ? '' : String(tier.input),
                outputPerMillion: tier.output == null ? '' : String(tier.output),
                cacheReadPerMillion: tier.cacheRead == null ? '' : String(tier.cacheRead),
                cacheWritePerMillion: tier.cacheWrite == null ? '' : String(tier.cacheWrite),
                reasoningPerMillion: tier.reasoning == null ? '' : String(tier.reasoning),
            }));
    } catch {
        return [];
    }
}

function findPricing(database: SqliteDatabase, rawModelId: string): Data | null {
    const candidates = expandModelIdCandidates(rawModelId).map((item) => item.candidate);
    const aliases = database
        .prepare('SELECT alias, model_id FROM llm_metadata_aliases')
        .all() as Data[];
    const aliasModels = aliases
        .filter((row) => candidates.includes(String(row.alias)))
        .map((row) => String(row.model_id));
    const order = [...candidates, ...aliasModels].filter(
        (value, index, list) => list.indexOf(value) === index
    );
    const rows = database
        .prepare(
            `SELECT model_id, input_cost_per_million, output_cost_per_million,
                    cache_read_cost_per_million, cache_write_cost_per_million,
                    reasoning_cost_per_million, cost_currency, cost_tiers
             FROM llm_metadata`
        )
        .all() as Data[];
    const rank = new Map(order.map((value, index) => [value, index]));
    const best = rows
        .filter(
            (row) =>
                order.includes(String(row.model_id)) &&
                row.input_cost_per_million !== null &&
                row.output_cost_per_million !== null
        )
        .sort(
            (left, right) =>
                (rank.get(String(left.model_id)) ?? Number.MAX_SAFE_INTEGER) -
                (rank.get(String(right.model_id)) ?? Number.MAX_SAFE_INTEGER)
        )[0];
    if (!best) return null;
    const output = String(best.output_cost_per_million);
    return {
        modelId: best.model_id,
        inputPerMillion: best.input_cost_per_million,
        outputPerMillion: output,
        cacheReadPerMillion: best.cache_read_cost_per_million ?? '0',
        cacheWritePerMillion: best.cache_write_cost_per_million ?? '0',
        reasoningPerMillion: best.reasoning_cost_per_million ?? output,
        currency: best.cost_currency ?? 'USD',
        tiers: parseTiers(best.cost_tiers),
    };
}

function loadMessageRows(database: SqliteDatabase, sessionId: number): Data[] {
    const messages = database
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id')
        .all(sessionId) as Data[];
    const parts = database
        .prepare(
            `SELECT message_parts.*
             FROM message_parts
             INNER JOIN messages ON messages.id = message_parts.message_id
             WHERE messages.session_id = ?
             ORDER BY message_parts.message_id, message_parts.sort_order, message_parts.id`
        )
        .all(sessionId) as Data[];
    const attachments = database
        .prepare(
            `SELECT
                 message_parts.message_id,
                 message_parts.sort_order,
                 attachments.id,
                 attachments.hash,
                 attachments.type,
                 attachments.original_name,
                 json_extract(message_parts.data, '$.originPath') AS origin_path,
                 json_extract(message_parts.data, '$.toolCallId') AS tool_call_id,
                 json_extract(message_parts.data, '$.toolKind') AS tool_kind,
                 attachments.mime_type,
                 attachments.size,
                 attachments.created_at
             FROM message_parts
             INNER JOIN messages ON messages.id = message_parts.message_id
             INNER JOIN attachments ON attachments.id = message_parts.attachment_id
             WHERE messages.session_id = ? AND message_parts.type = 'attachment'
             ORDER BY message_parts.message_id, message_parts.sort_order, message_parts.id`
        )
        .all(sessionId) as Data[];

    const partsByMessage = new Map<number, Data[]>();
    for (const part of parts) {
        const messageId = Number(part.message_id);
        const rows = partsByMessage.get(messageId) ?? [];
        rows.push(part);
        partsByMessage.set(messageId, rows);
    }
    const attachmentsByMessage = new Map<number, Data[]>();
    for (const attachment of attachments) {
        const messageId = Number(attachment.message_id);
        const rows = attachmentsByMessage.get(messageId) ?? [];
        rows.push(attachment);
        attachmentsByMessage.set(messageId, rows);
    }

    return messages.map((message) => ({
        ...message,
        parts: partsByMessage.get(Number(message.id)) ?? [],
        attachments: attachmentsByMessage.get(Number(message.id)) ?? [],
    }));
}

function isContextSummaryPart(part: Data, messageId: number): boolean {
    try {
        const metadata = JSON.parse(String(part.data)) as Data;
        if (
            metadata.version !== 2 ||
            (metadata.invalidatedAt !== undefined && metadata.invalidatedAt !== null)
        )
            return false;
        if (
            typeof metadata.id !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                metadata.id
            )
        ) {
            return false;
        }
        const content = String(part.content ?? '').trim();
        if (content.length === 0 || [...content].length > 32_000) return false;
        const firstKept = Number(metadata.firstKeptMessageId);
        if (!Number.isInteger(firstKept) || firstKept <= 0 || firstKept > messageId) return false;
        const systemIds = metadata.systemMessageIds;
        if (!Array.isArray(systemIds)) return false;
        const unique = new Set<number>();
        for (const value of systemIds) {
            const id = Number(value);
            if (!Number.isInteger(id) || id <= 0 || id >= firstKept || unique.has(id)) return false;
            unique.add(id);
        }
        return true;
    } catch {
        return false;
    }
}

function contextOperation(database: SqliteDatabase, sessionId: number): Data {
    const messages = loadMessageRows(database, sessionId);
    const summaryPart =
        (database
            .prepare(
                `SELECT message_parts.*
                 FROM messages
                 INNER JOIN message_parts ON message_parts.message_id = messages.id
                 WHERE messages.session_id = ? AND message_parts.type = 'context_compaction'
                 ORDER BY message_parts.id DESC
                 LIMIT 1`
            )
            .get(sessionId) as Data | undefined) ?? null;
    if (!summaryPart || !isContextSummaryPart(summaryPart, Number(summaryPart.message_id))) {
        return { messages, summaryPart: null };
    }
    const metadata = JSON.parse(String(summaryPart.data)) as Data;
    const firstKept = Number(metadata.firstKeptMessageId);
    const systemIds = new Set((metadata.systemMessageIds as unknown[]).map(Number));
    const selected = messages.filter((message) => {
        const id = Number(message.id);
        return id >= firstKept || systemIds.has(id);
    });
    const systemRolesMatch = selected
        .filter((message) => systemIds.has(Number(message.id)))
        .every((message) => message.role === 'system');
    return systemRolesMatch ? { messages: selected, summaryPart } : { messages, summaryPart: null };
}

function ensureAttachment(database: SqliteDatabase, input: Data): Data {
    if (
        typeof input.attachmentId === 'number' &&
        typeof input.hash === 'string' &&
        input.hash.trim()
    ) {
        const existing = database
            .prepare('SELECT * FROM attachments WHERE id = ?')
            .get(input.attachmentId) as Data | undefined;
        if (!existing) {
            throw Object.assign(new Error('Attachment was not found'), {
                code: 'not-found',
            });
        }
        return existing;
    }
    const hash = typeof input.hash === 'string' ? input.hash.trim() : '';
    if (!hash) {
        throw Object.assign(new Error('Attachment hash is required'), {
            code: 'validation',
        });
    }
    const inserted = database
        .prepare(
            `INSERT INTO attachments (hash, type, original_name, origin_path, mime_type, size)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(hash) DO NOTHING
             RETURNING *`
        )
        .get(
            hash,
            String(input.type),
            String(input.originalName),
            String(input.originPath),
            (input.mimeType as SQLInputValue | undefined) ?? null,
            (input.size as SQLInputValue | undefined) ?? null
        ) as Data | undefined;
    const row =
        inserted ??
        (database.prepare('SELECT * FROM attachments WHERE hash = ?').get(hash) as
            | Data
            | undefined);
    if (!row) {
        throw Object.assign(new Error('Failed to load attachment'), {
            code: 'unavailable',
        });
    }
    return row;
}

function linkAttachment(
    database: SqliteDatabase,
    messageId: number,
    attachmentId: number,
    originPath: string,
    toolCallId: string | null = null,
    toolKind: string | null = null
): void {
    const data: Data = { attachmentId, originPath };
    if (toolCallId !== null) data.toolCallId = toolCallId;
    if (toolKind !== null) data.toolKind = toolKind;
    database
        .prepare(
            `INSERT INTO message_parts (message_id, type, content, data, sort_order)
             VALUES (?, 'attachment', '', ?, (
                 SELECT COALESCE(MAX(sort_order), -1) + 1
                 FROM message_parts WHERE message_id = ?
             ))`
        )
        .run(messageId, JSON.stringify(data), messageId);
}

function linkAttachments(database: SqliteDatabase, messageId: number, attachments: unknown): void {
    if (!Array.isArray(attachments)) return;
    for (const attachment of attachments as Data[]) {
        const row = ensureAttachment(database, attachment);
        linkAttachment(database, messageId, Number(row.id), String(attachment.originPath));
    }
}

function syncOutputParts(database: SqliteDatabase, messageId: number, drafts: Data[]): void {
    const existing = database
        .prepare(
            `SELECT * FROM message_parts
             WHERE message_id = ? AND type IN ('text', 'reasoning')
             ORDER BY sort_order, id`
        )
        .all(messageId) as Data[];
    const reservedOrders = new Set(
        (
            database
                .prepare(
                    `SELECT sort_order FROM message_parts
                     WHERE message_id = ? AND type NOT IN ('text', 'reasoning')`
                )
                .all(messageId) as Data[]
        ).map((part) => Number(part.sort_order))
    );
    for (const previous of existing) {
        database
            .prepare('UPDATE message_parts SET sort_order = ? WHERE id = ?')
            .run(-Number(previous.id), Number(previous.id));
    }
    let sortOrder = 0;
    drafts.forEach((draft, index) => {
        while (reservedOrders.has(sortOrder)) sortOrder += 1;
        const partData = typeof draft.data === 'string' ? draft.data : '{}';
        const previous = existing[index];
        if (previous) {
            database
                .prepare(
                    `UPDATE message_parts
                     SET type = ?, content = ?, data = ?, started_at = ?, ended_at = ?,
                         sort_order = ?, updated_at = datetime('now')
                     WHERE id = ?`
                )
                .run(
                    String(draft.type),
                    String(draft.content),
                    partData,
                    (draft.startedAt as SQLInputValue | undefined) ?? null,
                    (draft.endedAt as SQLInputValue | undefined) ?? null,
                    sortOrder,
                    Number(previous.id)
                );
            sortOrder += 1;
            return;
        }
        insertRow(database, 'message_parts', {
            message_id: messageId,
            type: draft.type,
            content: draft.content,
            data: partData,
            started_at: draft.startedAt ?? null,
            ended_at: draft.endedAt ?? null,
            sort_order: sortOrder,
        });
        sortOrder += 1;
    });
    for (const previous of existing.slice(drafts.length)) {
        database.prepare('DELETE FROM message_parts WHERE id = ?').run(Number(previous.id));
    }
}

function writeOutputMessage(
    database: SqliteDatabase,
    sessionId: number,
    role: string,
    messageId: number | null,
    parts: Data[]
): Data {
    const resolvedMessageId =
        messageId ??
        Number(
            insertRow(database, 'messages', {
                session_id: sessionId,
                role,
            })?.id
        );
    if (messageId !== null) {
        database
            .prepare("UPDATE messages SET role = ?, updated_at = datetime('now') WHERE id = ?")
            .run(role, resolvedMessageId);
    }
    if (parts.length > 0) syncOutputParts(database, resolvedMessageId, parts);
    routeDatabaseOperation(database, {
        cmd: 'database_operation',
        payload: { request: { kind: 'session_refresh_metadata', id: sessionId } },
    });
    return database.prepare('SELECT * FROM messages WHERE id = ?').get(resolvedMessageId) as Data;
}

function writeLlmCallParts(database: SqliteDatabase, messageId: number, calls: Data[]): void {
    if (calls.length === 0) return;
    const maximum = Number(
        (
            database
                .prepare(
                    'SELECT COALESCE(MAX(sort_order), -1) AS value FROM message_parts WHERE message_id = ?'
                )
                .get(messageId) as Data
        ).value
    );
    calls.forEach((call, index) => {
        JSON.parse(String(call.data));
        insertRow(database, 'message_parts', {
            message_id: messageId,
            type: 'llm_call',
            content: '',
            data: call.data,
            started_at: call.startedAt ?? null,
            ended_at: call.endedAt ?? null,
            sort_order: maximum + 1 + index,
        });
    });
}

function usagePatch(summary: Data): Data {
    return {
        input_tokens: summary.inputTokens ?? 0,
        output_tokens: summary.outputTokens ?? 0,
        cache_read_tokens: summary.cacheReadTokens ?? 0,
        cache_write_tokens: summary.cacheWriteTokens ?? 0,
        reasoning_tokens: summary.reasoningTokens ?? 0,
        total_cost_micros: summary.totalCostMicros ?? 0,
        unpriced_calls: summary.unpricedCalls ?? 0,
        ttft_ms: summary.ttftMs ?? null,
        llm_call_count: summary.llmCallCount ?? 0,
    };
}

function updateAttemptUsage(database: SqliteDatabase, attemptId: number, usage: Data): void {
    updateById(database, 'session_turn_attempts', attemptId, {
        ...usagePatch(usage.summary as Data),
        updated_at: new Date().toISOString(),
    });
}

function recomputeTurnUsage(database: SqliteDatabase, turnId: number, behavior: Data): void {
    database
        .prepare(
            `UPDATE session_turns
             SET
                 input_tokens = (SELECT COALESCE(SUM(input_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
                 output_tokens = (SELECT COALESCE(SUM(output_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
                 cache_read_tokens = (SELECT COALESCE(SUM(cache_read_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
                 cache_write_tokens = (SELECT COALESCE(SUM(cache_write_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
                 reasoning_tokens = (SELECT COALESCE(SUM(reasoning_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
                 total_cost_micros = (SELECT COALESCE(SUM(total_cost_micros), 0) FROM session_turn_attempts WHERE turn_id = ?),
                 unpriced_calls = (SELECT COALESCE(SUM(unpriced_calls), 0) FROM session_turn_attempts WHERE turn_id = ?),
                 llm_call_count = (SELECT COALESCE(SUM(llm_call_count), 0) FROM session_turn_attempts WHERE turn_id = ?),
                 ttft_ms = (
                     SELECT ttft_ms FROM session_turn_attempts
                     WHERE turn_id = ? AND ttft_ms IS NOT NULL
                     ORDER BY attempt_index LIMIT 1
                 ),
                 first_text_ms = ?,
                 tool_call_count = ?,
                 tool_argument_error_count = ?,
                 model_switch_count = ?,
                 hit_iteration_ceiling = ?,
                 error_code = ?,
                 retry_scope = ?,
                 updated_at = datetime('now')
             WHERE id = ?`
        )
        .run(
            ...Array.from({ length: 9 }, () => turnId),
            behavior.firstTextMs === null || behavior.firstTextMs === undefined
                ? null
                : Number(behavior.firstTextMs),
            Number(behavior.toolCallCount ?? 0),
            Number(behavior.toolArgumentErrorCount ?? 0),
            Number(behavior.modelSwitchCount ?? 0),
            behavior.hitIterationCeiling ? 1 : 0,
            behavior.errorCode === null || behavior.errorCode === undefined
                ? null
                : String(behavior.errorCode),
            behavior.retryScope === null || behavior.retryScope === undefined
                ? null
                : String(behavior.retryScope),
            turnId
        );
}

function contextMessageFingerprint(message: Data, parts: Data[]): string {
    const semanticParts = parts
        .filter((part) => !['context_compaction', 'llm_call'].includes(String(part.type)))
        .map((part) => [part.type, part.content, part.data, part.sort_order]);
    return createHash('sha256')
        .update(JSON.stringify([message.role, semanticParts]))
        .digest('hex');
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.entries(value as Data)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function contextSummaryIdentity(metadata: Data, text: unknown): Data {
    return {
        ...Object.fromEntries(
            ['version', 'id', 'firstKeptMessageId', 'systemMessageIds', 'invalidatedAt']
                .filter((key) => metadata[key] !== undefined)
                .map((key) => [key, metadata[key]])
        ),
        text,
    };
}

/**
 * Routes one typed database operation to the test database. The production
 * bridge deliberately has no generic SQL fallback, so this is the test-side
 * equivalent of the Rust repository dispatch.
 */
export function routeDatabaseOperation(
    database: SqliteDatabase,
    call: { cmd: string; payload?: unknown }
): { value: unknown } | undefined {
    if (call.cmd !== 'database_operation') return undefined;
    const request = (call.payload as { request?: OperationRequest } | undefined)?.request;
    if (!request) return { value: undefined };
    const usageOperation = routeUsageOperation(database, request);
    if (usageOperation) return usageOperation;

    const read = (sql: string, params: SQLInputValue[] = []) =>
        database.prepare(sql).all(...params) as Data[];
    const run = (sql: string, params: SQLInputValue[] = []) => database.prepare(sql).run(...params);
    const data = (value: unknown) => value as Data;
    const dataList = (value: unknown) => value as Data[];

    switch (request.kind) {
        case 'setting_find':
            return {
                value:
                    read('SELECT * FROM settings WHERE key = ? LIMIT 1', [
                        String(request.key),
                    ])[0] ?? null,
            };
        case 'setting_get':
            return {
                value:
                    (
                        read('SELECT value FROM settings WHERE key = ? LIMIT 1', [
                            String(request.key),
                        ])[0] as Data | undefined
                    )?.value ?? null,
            };
        case 'setting_get_many': {
            const keys = (request.keys as string[] | undefined) ?? [];
            if (keys.length === 0) return { value: {} };
            const rows = read(
                `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`,
                keys
            ) as Array<{ key: string; value: string | null }>;
            const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
            return {
                value: Object.fromEntries(keys.map((key) => [key, values[key] ?? null])),
            };
        }
        case 'setting_set':
            return {
                value: database
                    .prepare(
                        `INSERT INTO settings (key, value) VALUES (?, ?)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value
                         RETURNING *`
                    )
                    .get(String(request.key), String(request.value)),
            };
        case 'statistic_get':
            return {
                value:
                    (
                        read('SELECT value FROM statistics WHERE key = ? LIMIT 1', [
                            String(request.key),
                        ])[0] as Data | undefined
                    )?.value ?? null,
            };
        case 'statistic_set':
            run(
                `INSERT INTO statistics (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                [String(request.key), String(request.value)]
            );
            return { value: true };
        case 'meta_get':
            return {
                value:
                    (
                        read('SELECT value FROM touchai_meta WHERE key = ? LIMIT 1', [
                            String(request.key),
                        ])[0] as Data | undefined
                    )?.value ?? null,
            };
        case 'meta_set':
            run(
                `INSERT INTO touchai_meta (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                [String(request.key), String(request.value)]
            );
            return { value: null };
        case 'meta_delete':
            run('DELETE FROM touchai_meta WHERE key = ?', [String(request.key)]);
            return { value: null };
        case 'quick_search_find':
            return {
                value: read(
                    `SELECT path_norm, click_count, query_norm
                     FROM quick_search_click_stats
                     WHERE query_norm = ?
                     ORDER BY click_count DESC, updated_at DESC
                     LIMIT ?`,
                    [String(request.queryNorm), Number(request.limit)]
                ),
            };
        case 'quick_search_find_recent':
            return {
                value: read(
                    `SELECT path_norm, click_count, query_norm, updated_at
                     FROM quick_search_click_stats
                     WHERE query_norm = ?
                     ORDER BY updated_at DESC, click_count DESC, path_norm
                     LIMIT ?`,
                    [String(request.queryNorm), Number(request.limit)]
                ),
            };
        case 'quick_search_upsert':
            if (!request.queryNorm || !request.pathNorm) return { value: null };
            run(
                `INSERT INTO quick_search_click_stats (query_norm, path_norm, click_count, updated_at)
                 VALUES (?, ?, 1, strftime('%Y-%m-%d %H:%M:%f', 'now'))
                 ON CONFLICT(query_norm, path_norm) DO UPDATE SET
                   click_count = CASE
                     WHEN quick_search_click_stats.click_count >= ? THEN ?
                     ELSE quick_search_click_stats.click_count + 1
                   END,
                   updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')`,
                [
                    String(request.queryNorm),
                    String(request.pathNorm),
                    Number(request.maxClickCount),
                    Number(request.maxClickCount),
                ]
            );
            return { value: null };
        case 'session_create': {
            const created = insertRow(database, 'sessions', data(request.data));
            return {
                value: created ? { ...created, pending_terminal_status: null } : null,
            };
        }
        case 'session_find_by_id':
            return {
                value:
                    read(`${SESSION_SELECT} WHERE sessions.id = ? LIMIT 1`, [
                        Number(request.id),
                    ])[0] ?? null,
            };
        case 'session_list': {
            const query = String(request.query ?? '').trim();
            const params: SQLInputValue[] = [];
            let where = '';
            if (query) {
                const pattern = `%${escapeLikePattern(query)}%`;
                const trigramExpression = buildSessionSearchTrigramExpression(query);
                const fts = trigramExpression
                    ? `AND searchable_messages.id IN (
                           SELECT rowid FROM message_search_fts
                           WHERE message_search_fts MATCH ?
                       )`
                    : '';
                where = ` WHERE (
                    lower(sessions.title) LIKE lower(?) ESCAPE '\\'
                    OR EXISTS (
                        SELECT 1
                        FROM messages searchable_messages
                        WHERE searchable_messages.session_id = sessions.id
                          AND searchable_messages.role IN ('user', 'assistant', 'tool_call')
                          ${fts}
                          AND lower(${messageTextSql('searchable_messages')}) LIKE lower(?) ESCAPE '\\'
                    )
                )`;
                params.push(pattern);
                if (trigramExpression) params.push(trigramExpression);
                params.push(pattern);
            }
            params.push(normalizeSessionLimit(request.limit));
            return {
                value: read(
                    `${SESSION_SELECT}${where}
                     ORDER BY COALESCE(sessions.last_message_at, sessions.updated_at) DESC,
                              sessions.id DESC
                     LIMIT ?`,
                    params
                ),
            };
        }
        case 'session_messages':
            return { value: loadMessageRows(database, Number(request.sessionId)) };
        case 'session_context':
            return { value: contextOperation(database, Number(request.sessionId)) };
        case 'session_history': {
            const sessionId = Number(request.sessionId);
            const session = read(`${SESSION_SELECT} WHERE sessions.id = ? LIMIT 1`, [sessionId])[0];
            if (!session) {
                throw Object.assign(new Error('Session was not found'), {
                    code: 'not-found',
                });
            }
            const turns = read(
                `SELECT
                     id, session_id, task_id, execution_mode, prompt_snapshot_json,
                     prompt_message_id, response_message_id, status, error_message,
                     created_at, updated_at
                 FROM session_turns
                 WHERE session_id = ?
                 ORDER BY created_at, id`,
                [sessionId]
            );
            const attempts = read(
                `SELECT
                     session_turn_attempts.id,
                     session_turn_attempts.turn_id,
                     session_turn_attempts.attempt_index,
                     session_turn_attempts.max_retries,
                     session_turn_attempts.status,
                     session_turn_attempts.checkpoint_json,
                     session_turn_attempts.delivery_manifest_json,
                     session_turn_attempts.error_message,
                     session_turn_attempts.started_at,
                     session_turn_attempts.finished_at,
                     session_turn_attempts.created_at,
                     session_turn_attempts.updated_at
                 FROM session_turn_attempts
                 INNER JOIN session_turns ON session_turns.id = session_turn_attempts.turn_id
                 WHERE session_turns.session_id = ?
                 ORDER BY session_turn_attempts.turn_id,
                          session_turn_attempts.attempt_index,
                          session_turn_attempts.id`,
                [sessionId]
            );
            const model =
                read(
                    `${MODEL_WITH_PROVIDER}
                     INNER JOIN session_turns ON session_turns.model_id = models.id
                     WHERE session_turns.session_id = ?
                     ORDER BY session_turns.created_at DESC, session_turns.id DESC
                     LIMIT 1`,
                    [sessionId]
                )[0] ?? null;
            return {
                value: {
                    session,
                    messages: loadMessageRows(database, sessionId),
                    turns,
                    attempts,
                    model,
                },
            };
        }
        case 'session_update': {
            const patch = data(request.data);
            const keys = Object.keys(patch).filter((key) => key !== 'updated_at');
            const assignments = keys.map((key) => `"${key}" = ?`).join(', ');
            const updated = database
                .prepare(
                    `UPDATE sessions SET ${assignments ? `${assignments}, ` : ''}
                     updated_at = datetime('now') WHERE id = ? RETURNING *`
                )
                .get(...keys.map((key) => sqlValue(patch[key])), Number(request.id));
            return { value: updated ?? null };
        }
        case 'session_dismiss_terminal_status':
            transaction(database, () => {
                const latest = read(
                    `SELECT id, status FROM session_turns
                     WHERE session_id = ?
                     ORDER BY created_at DESC, id DESC LIMIT 1`,
                    [Number(request.id)]
                )[0];
                if (!latest || (latest.status !== 'completed' && latest.status !== 'failed')) {
                    return;
                }
                run('UPDATE sessions SET status_badge_dismissed_turn_id = ? WHERE id = ?', [
                    Number(latest.id),
                    Number(request.id),
                ]);
            });
            return { value: null };
        case 'session_refresh_metadata': {
            const id = Number(request.id);
            const assistantText = messageTextSql('assistant_messages');
            const toolText = messageTextSql('tool_call_messages');
            const userText = messageTextSql('user_messages');
            run(
                `UPDATE sessions
                 SET
                     message_count = (
                         SELECT count(*) FROM messages counted_messages
                         WHERE counted_messages.session_id = ?
                           AND counted_messages.role IN ('user', 'assistant')
                     ),
                     last_message_at = COALESCE(
                         (
                             SELECT assistant_messages.created_at
                             FROM messages assistant_messages
                             WHERE assistant_messages.session_id = ?
                               AND assistant_messages.role = 'assistant'
                               AND trim(${assistantText}) <> ''
                             ORDER BY assistant_messages.created_at DESC, assistant_messages.id DESC
                             LIMIT 1
                         ),
                         (
                             SELECT tool_call_messages.created_at
                             FROM messages tool_call_messages
                             WHERE tool_call_messages.session_id = ?
                               AND tool_call_messages.role = 'tool_call'
                               AND trim(${toolText}) <> ''
                             ORDER BY tool_call_messages.created_at DESC, tool_call_messages.id DESC
                             LIMIT 1
                         ),
                         (
                             SELECT user_messages.created_at
                             FROM messages user_messages
                             WHERE user_messages.session_id = ?
                               AND user_messages.role = 'user'
                             ORDER BY user_messages.created_at DESC, user_messages.id DESC
                             LIMIT 1
                         )
                     ),
                     last_message_preview = COALESCE(
                         (
                             SELECT CASE
                                 WHEN length(${assistantText}) > 160
                                     THEN substr(${assistantText}, 1, 160) || '...'
                                 ELSE ${assistantText}
                             END
                             FROM messages assistant_messages
                             WHERE assistant_messages.session_id = ?
                               AND assistant_messages.role = 'assistant'
                               AND trim(${assistantText}) <> ''
                             ORDER BY assistant_messages.created_at DESC, assistant_messages.id DESC
                             LIMIT 1
                         ),
                         (
                             SELECT CASE
                                 WHEN length(${toolText}) > 160
                                     THEN substr(${toolText}, 1, 160) || '...'
                                 ELSE ${toolText}
                             END
                             FROM messages tool_call_messages
                             WHERE tool_call_messages.session_id = ?
                               AND tool_call_messages.role = 'tool_call'
                               AND trim(${toolText}) <> ''
                             ORDER BY tool_call_messages.created_at DESC, tool_call_messages.id DESC
                             LIMIT 1
                         ),
                         (
                             SELECT CASE
                                 WHEN length(${userText}) > 160
                                     THEN substr(${userText}, 1, 160) || '...'
                                 ELSE ${userText}
                             END
                             FROM messages user_messages
                             WHERE user_messages.session_id = ?
                               AND user_messages.role = 'user'
                             ORDER BY user_messages.created_at DESC, user_messages.id DESC
                             LIMIT 1
                         )
                     ),
                     provider_id = COALESCE(
                         (
                             SELECT latest_models.provider_id
                             FROM session_turns latest_turns
                             INNER JOIN models latest_models
                                 ON latest_models.id = latest_turns.model_id
                             WHERE latest_turns.session_id = ?
                             ORDER BY latest_turns.created_at DESC, latest_turns.id DESC
                             LIMIT 1
                         ),
                         sessions.provider_id
                     ),
                     updated_at = datetime('now')
                 WHERE id = ?`,
                [id, id, id, id, id, id, id, id, id]
            );
            return { value: null };
        }
        case 'session_count':
            return {
                value: Number((read('SELECT count(*) AS count FROM sessions')[0] as Data).count),
            };
        case 'session_delete_all':
            run('DELETE FROM sessions');
            return { value: null };
        case 'message_count':
            return {
                value: Number((read('SELECT count(*) AS count FROM messages')[0] as Data).count),
            };
        case 'message_delete_all':
            transaction(database, () => run('DELETE FROM messages'));
            return { value: null };
        case 'session_turn_count':
            return {
                value: Number(
                    (read('SELECT count(*) AS count FROM session_turns')[0] as Data).count
                ),
            };
        case 'session_turn_delete_all':
            transaction(database, () => {
                run('DELETE FROM session_turn_attempts');
                run('DELETE FROM session_turns');
            });
            return { value: null };
        case 'attachment_ensure':
            return { value: ensureAttachment(database, data(request.input)) };
        case 'task_record_start': {
            const input = data(request.input);
            const value = transaction(database, () => {
                const sessionId =
                    input.sessionId === null || input.sessionId === undefined
                        ? Number(
                              insertRow(database, 'sessions', {
                                  session_id: crypto.randomUUID(),
                                  title: input.sessionTitle,
                                  model: input.modelName,
                                  provider_id: input.providerId,
                              })?.id
                          )
                        : Number(input.sessionId);
                if (input.sessionId !== null && input.sessionId !== undefined) {
                    run(
                        `UPDATE sessions
                         SET model = ?, provider_id = ?, updated_at = datetime('now')
                         WHERE id = ?`,
                        [String(input.modelName), Number(input.providerId), sessionId]
                    );
                }

                let userMessageId =
                    typeof input.existingUserMessageId === 'number'
                        ? input.existingUserMessageId
                        : null;
                if (userMessageId === null) {
                    userMessageId = Number(
                        insertRow(database, 'messages', {
                            session_id: sessionId,
                            role: 'user',
                        })?.id
                    );
                    if (String(input.prompt ?? '').length > 0) {
                        insertRow(database, 'message_parts', {
                            message_id: userMessageId,
                            type: 'text',
                            content: input.prompt,
                            sort_order: 0,
                        });
                    }
                    linkAttachments(database, userMessageId, input.attachments);
                    routeDatabaseOperation(database, {
                        cmd: 'database_operation',
                        payload: {
                            request: { kind: 'session_refresh_metadata', id: sessionId },
                        },
                    });
                }

                const turn =
                    typeof input.existingTurnId === 'number'
                        ? (read('SELECT * FROM session_turns WHERE id = ? LIMIT 1', [
                              input.existingTurnId,
                          ])[0] ??
                          (() => {
                              throw Object.assign(new Error('Session turn was not found'), {
                                  code: 'not-found',
                              });
                          })())
                        : insertRow(database, 'session_turns', {
                              session_id: sessionId,
                              model_id: input.modelId,
                              task_id: input.taskId,
                              execution_mode: input.executionMode,
                              prompt_snapshot_json: input.promptSnapshotJson,
                              prompt_message_id: userMessageId,
                              response_message_id: null,
                              status: 'streaming',
                          })!;
                const turnId = Number(turn.id);
                if (input.promptBreakdownJson) {
                    run(
                        `UPDATE session_turns
                         SET prompt_breakdown_json = ?, updated_at = datetime('now')
                         WHERE id = ?`,
                        [String(input.promptBreakdownJson), turnId]
                    );
                }
                const attempt =
                    typeof input.existingAttemptId === 'number'
                        ? (read(
                              'SELECT * FROM session_turn_attempts WHERE id = ? AND turn_id = ? LIMIT 1',
                              [input.existingAttemptId, turnId]
                          )[0] ??
                          (() => {
                              throw Object.assign(new Error('Session turn attempt was not found'), {
                                  code: 'not-found',
                              });
                          })())
                        : insertRow(database, 'session_turn_attempts', {
                              turn_id: turnId,
                              attempt_index: 1,
                              max_retries: input.maxRetries,
                              status: 'streaming',
                              checkpoint_json: input.checkpointJson,
                              delivery_manifest_json: input.deliveryManifestJson,
                              started_at: input.startedAt,
                              created_at: input.startedAt,
                              updated_at: input.startedAt,
                          })!;
                return {
                    session_id: sessionId,
                    user_message_id: userMessageId,
                    turn,
                    attempt,
                };
            });
            return { value };
        }
        case 'task_persist_output_message': {
            const input = data(request.input);
            const value = transaction(database, () => {
                const message = writeOutputMessage(
                    database,
                    Number(input.sessionId),
                    String(input.role),
                    typeof input.messageId === 'number' ? input.messageId : null,
                    Array.isArray(input.parts) ? (input.parts as Data[]) : []
                );
                if (!input.linkTurn) return { message, turn: null };
                const turnId = Number(input.turnId);
                run(
                    `UPDATE session_turns
                     SET response_message_id = ?, updated_at = datetime('now')
                     WHERE id = ?`,
                    [Number(message.id), turnId]
                );
                const turn = read('SELECT * FROM session_turns WHERE id = ? LIMIT 1', [turnId])[0];
                return { message, turn };
            });
            return { value };
        }
        case 'task_persist_tool_result': {
            const input = data(request.input);
            const value = transaction(database, () => {
                let part: Data | undefined;
                if (typeof input.toolCallPartId === 'number') {
                    part = read(
                        `SELECT message_parts.*, messages.session_id
                         FROM message_parts
                         INNER JOIN messages ON messages.id = message_parts.message_id
                         WHERE message_parts.id = ? AND message_parts.type = 'tool_call'`,
                        [input.toolCallPartId]
                    )[0];
                } else if (
                    typeof input.toolCallId === 'string' &&
                    typeof input.toolCallMessageId === 'number'
                ) {
                    part = read(
                        `SELECT message_parts.*, messages.session_id
                         FROM message_parts
                         INNER JOIN messages ON messages.id = message_parts.message_id
                         WHERE message_parts.type = 'tool_call'
                           AND message_parts.tool_call_id = ?
                           AND message_parts.message_id = ?
                         ORDER BY message_parts.id LIMIT 1`,
                        [input.toolCallId, input.toolCallMessageId]
                    )[0];
                }
                if (!part) return { part: null };
                const partData = JSON.parse(String(part.data)) as Data;
                partData.output = input.result;
                const updated = database
                    .prepare(
                        `UPDATE message_parts
                         SET data = ?, updated_at = datetime('now')
                         WHERE id = ?
                         RETURNING *`
                    )
                    .get(JSON.stringify(partData), Number(part.id)) as Data;
                if (Array.isArray(input.attachments)) {
                    for (const attachment of input.attachments as Data[]) {
                        const attachmentRow = ensureAttachment(database, attachment);
                        linkAttachment(
                            database,
                            Number(part.message_id),
                            Number(attachmentRow.id),
                            String(attachment.originPath),
                            typeof part.tool_call_id === 'string' ? part.tool_call_id : null,
                            typeof part.tool_kind === 'string' ? part.tool_kind : null
                        );
                    }
                }
                routeDatabaseOperation(database, {
                    cmd: 'database_operation',
                    payload: {
                        request: {
                            kind: 'session_refresh_metadata',
                            id: Number(part.session_id),
                        },
                    },
                });
                return { part: updated };
            });
            return { value };
        }
        case 'task_update_attempt': {
            const input = data(request.input);
            const patch: Data = {};
            if (input.checkpointJson !== null && input.checkpointJson !== undefined) {
                patch.checkpoint_json = input.checkpointJson;
            }
            if (input.deliveryManifestJson !== null && input.deliveryManifestJson !== undefined) {
                patch.delivery_manifest_json = input.deliveryManifestJson;
            }
            if (Object.keys(patch).length === 0) {
                throw Object.assign(new Error('At least one attempt field is required'), {
                    code: 'validation',
                });
            }
            return {
                value: transaction(database, () =>
                    updateById(database, 'session_turn_attempts', Number(input.attemptId), patch)
                ),
            };
        }
        case 'task_finish': {
            const input = data(request.input);
            const value = transaction(database, () => {
                const parts = Array.isArray(input.parts) ? (input.parts as Data[]) : [];
                const pendingMessageId =
                    typeof input.pendingMessageId === 'number' ? input.pendingMessageId : null;
                let assistantMessageId =
                    typeof input.assistantMessageId === 'number'
                        ? input.assistantMessageId
                        : pendingMessageId;
                if (input.assistantMessageId === null || input.assistantMessageId === undefined) {
                    if (parts.length > 0 || pendingMessageId !== null) {
                        const message = writeOutputMessage(
                            database,
                            Number(input.sessionId),
                            'assistant',
                            pendingMessageId,
                            parts
                        );
                        assistantMessageId = Number(message.id);
                    }
                }
                let turnId = typeof input.turnId === 'number' ? input.turnId : undefined;
                if (turnId === undefined) {
                    const bootstrap = input.turnBootstrap as Data | null;
                    if (!bootstrap) {
                        throw Object.assign(
                            new Error(
                                'A turn bootstrap is required when finishing without a turn id'
                            ),
                            { code: 'validation' }
                        );
                    }
                    const created = insertRow(database, 'session_turns', {
                        session_id: input.sessionId,
                        model_id: bootstrap.modelId,
                        task_id: bootstrap.taskId,
                        execution_mode: bootstrap.executionMode,
                        prompt_snapshot_json: bootstrap.promptSnapshotJson,
                        prompt_message_id: bootstrap.promptMessageId ?? null,
                        response_message_id: null,
                        status: 'streaming',
                    })!;
                    turnId = Number(created.id);
                }
                const usage = input.usage as Data | null;
                if (usage) {
                    if (typeof input.attemptId === 'number') {
                        updateAttemptUsage(database, input.attemptId, usage);
                    }
                    if (assistantMessageId !== null) {
                        writeLlmCallParts(
                            database,
                            assistantMessageId,
                            Array.isArray(usage.calls) ? (usage.calls as Data[]) : []
                        );
                    }
                }
                let attempt: Data | null = null;
                if (typeof input.attemptId === 'number') {
                    attempt =
                        updateById(database, 'session_turn_attempts', input.attemptId, {
                            status: input.status,
                            error_message: input.errorMessage ?? null,
                            duration_ms: input.durationMs ?? null,
                            finished_at: input.finishedAt,
                            updated_at: input.finishedAt,
                        }) ?? null;
                }
                const turnPatch: Data = {
                    status: input.status,
                    error_message: input.errorMessage ?? null,
                    response_message_id: assistantMessageId,
                    duration_ms: input.durationMs ?? null,
                };
                if (input.status === 'completed') {
                    turnPatch.tokens_used = input.tokensUsed ?? null;
                }
                updateById(database, 'session_turns', turnId, turnPatch);
                if (usage) {
                    recomputeTurnUsage(database, turnId, data(input.behavior));
                }
                return {
                    assistant_message_id: assistantMessageId,
                    turn: read('SELECT * FROM session_turns WHERE id = ?', [turnId])[0],
                    attempt,
                };
            });
            return { value };
        }
        case 'task_begin_next_attempt': {
            const input = data(request.input);
            const value = transaction(database, () => {
                const usage = input.usage as Data | null;
                if (usage) {
                    updateAttemptUsage(database, Number(input.currentAttemptId), usage);
                }
                updateById(database, 'session_turn_attempts', Number(input.currentAttemptId), {
                    status: 'failed',
                    error_message: input.errorMessage,
                    duration_ms: input.durationMs ?? null,
                    finished_at: input.finishedAt,
                    updated_at: input.finishedAt,
                });
                const attempt = insertRow(database, 'session_turn_attempts', {
                    turn_id: input.turnId,
                    attempt_index: input.attemptIndex,
                    max_retries: input.maxRetries,
                    status: 'streaming',
                    checkpoint_json: input.checkpointJson,
                    delivery_manifest_json: input.deliveryManifestJson,
                    started_at: input.startedAt,
                    created_at: input.startedAt,
                    updated_at: input.startedAt,
                })!;
                run(
                    `UPDATE session_turns
                     SET status = 'streaming', error_message = NULL,
                         updated_at = datetime('now')
                     WHERE id = ?`,
                    [Number(input.turnId)]
                );
                recomputeTurnUsage(database, Number(input.turnId), data(input.behavior));
                return {
                    turn: read('SELECT * FROM session_turns WHERE id = ?', [
                        Number(input.turnId),
                    ])[0],
                    attempt,
                };
            });
            return { value };
        }
        case 'task_persist_context_summary': {
            const input = data(request.input);
            const value = transaction(database, () => {
                const metadata = JSON.parse(String(input.summaryJson)) as Data;
                if (
                    metadata.version !== 2 ||
                    (metadata.invalidatedAt !== undefined && metadata.invalidatedAt !== null) ||
                    typeof metadata.id !== 'string' ||
                    String(input.text).trim().length === 0
                ) {
                    throw Object.assign(new Error('Context summary metadata is invalid'), {
                        code: 'validation',
                    });
                }
                const firstKept = Number(metadata.firstKeptMessageId);
                const boundary = read(
                    'SELECT id, role FROM messages WHERE id = ? AND session_id = ?',
                    [firstKept, Number(input.sessionId)]
                )[0];
                if (!boundary) {
                    throw Object.assign(
                        new Error('Context summary boundary message was not found'),
                        { code: 'validation' }
                    );
                }
                if (input.previousSummaryJson) {
                    const previous = JSON.parse(String(input.previousSummaryJson)) as Data;
                    const previousPart = read(
                        `SELECT message_parts.*
                         FROM messages
                         INNER JOIN message_parts ON message_parts.message_id = messages.id
                         WHERE messages.session_id = ?
                           AND message_parts.type = 'context_compaction'
                         ORDER BY message_parts.id DESC LIMIT 1`,
                        [Number(input.sessionId)]
                    )[0];
                    if (!previousPart) {
                        throw Object.assign(new Error('Previous context summary was not found'), {
                            code: 'validation',
                        });
                    }
                    const saved = JSON.parse(String(previousPart.data)) as Data;
                    if (
                        canonicalJson(contextSummaryIdentity(saved, previousPart.content)) !==
                        canonicalJson(previous)
                    ) {
                        throw Object.assign(new Error('Previous context summary changed'), {
                            code: 'validation',
                        });
                    }
                }
                const messages = read('SELECT * FROM messages WHERE session_id = ? ORDER BY id', [
                    Number(input.sessionId),
                ]);
                const allParts = read(
                    `SELECT message_parts.*
                     FROM message_parts
                     INNER JOIN messages ON messages.id = message_parts.message_id
                     WHERE messages.session_id = ?
                     ORDER BY message_parts.message_id, message_parts.sort_order, message_parts.id`,
                    [Number(input.sessionId)]
                );
                const partsByMessage = new Map<number, Data[]>();
                for (const part of allParts) {
                    const rows = partsByMessage.get(Number(part.message_id)) ?? [];
                    rows.push(part);
                    partsByMessage.set(Number(part.message_id), rows);
                }
                const sources = new Map<number, string>();
                for (const source of input.sourceMessages as Data[]) {
                    const id = Number(source.id);
                    const fingerprint = String(source.fingerprint);
                    const previous = sources.get(id);
                    if (previous !== undefined && previous !== fingerprint) {
                        throw Object.assign(
                            new Error('Context source message fingerprints conflict'),
                            { code: 'validation' }
                        );
                    }
                    sources.set(id, fingerprint);
                }
                const previousBoundary =
                    input.previousSummaryJson === null || input.previousSummaryJson === undefined
                        ? null
                        : Number(
                              (JSON.parse(String(input.previousSummaryJson)) as Data)
                                  .firstKeptMessageId
                          );
                const systemIds = new Set((metadata.systemMessageIds as unknown[]).map(Number));
                for (const message of messages) {
                    const id = Number(message.id);
                    const retained =
                        previousBoundary !== null && id < previousBoundary && sources.has(id);
                    const inRange =
                        previousBoundary === null
                            ? id < firstKept
                            : id >= previousBoundary && id < firstKept;
                    if (!retained && !inRange) continue;
                    if (systemIds.has(id) && message.role !== 'system') {
                        throw Object.assign(new Error('Context system message changed role'), {
                            code: 'validation',
                        });
                    }
                    const parts = partsByMessage.get(id) ?? [];
                    const hasVisibleText = parts.some(
                        (part) =>
                            ['text', 'reasoning'].includes(String(part.type)) &&
                            String(part.content ?? '').trim().length > 0
                    );
                    const expected = sources.get(id);
                    if (expected === undefined && message.role === 'assistant' && !hasVisibleText) {
                        continue;
                    }
                    if (expected !== contextMessageFingerprint(message, parts)) {
                        throw Object.assign(
                            new Error(
                                `Context source message ${id} changed (expected ${expected}, actual ${contextMessageFingerprint(message, parts)})`
                            ),
                            { code: 'validation' }
                        );
                    }
                    sources.delete(id);
                }
                if (sources.size > 0) {
                    throw Object.assign(
                        new Error(
                            `Context source messages are incomplete: ${[...sources.keys()].join(',')}`
                        ),
                        { code: 'validation' }
                    );
                }
                let messageId =
                    typeof input.pendingMessageId === 'number' ? input.pendingMessageId : null;
                if (messageId !== null) {
                    run(
                        "UPDATE messages SET role = 'assistant', updated_at = datetime('now') WHERE id = ?",
                        [messageId]
                    );
                } else {
                    messageId = Number(
                        insertRow(database, 'messages', {
                            session_id: input.sessionId,
                            role: 'assistant',
                        })?.id
                    );
                }
                const maximum = Number(
                    (
                        read(
                            'SELECT COALESCE(MAX(sort_order), -1) AS value FROM message_parts WHERE message_id = ?',
                            [messageId]
                        )[0] as Data
                    ).value
                );
                const createdAt = Number(metadata.createdAt);
                const part = insertRow(database, 'message_parts', {
                    message_id: messageId,
                    type: 'context_compaction',
                    content: input.text,
                    data: input.summaryJson,
                    started_at: createdAt,
                    ended_at: createdAt,
                    sort_order: maximum + 1,
                })!;
                run(
                    `UPDATE session_turns
                     SET response_message_id = ?, updated_at = datetime('now')
                     WHERE id = ?`,
                    [messageId, Number(input.turnId)]
                );
                const usage = input.usage as Data | null;
                if (usage) {
                    updateAttemptUsage(database, Number(input.attemptId), usage);
                    database
                        .prepare(
                            `UPDATE session_turns
                             SET
                                 input_tokens = (SELECT COALESCE(SUM(input_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
                                 output_tokens = (SELECT COALESCE(SUM(output_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
                                 cache_read_tokens = (SELECT COALESCE(SUM(cache_read_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
                                 cache_write_tokens = (SELECT COALESCE(SUM(cache_write_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
                                 reasoning_tokens = (SELECT COALESCE(SUM(reasoning_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
                                 total_cost_micros = (SELECT COALESCE(SUM(total_cost_micros), 0) FROM session_turn_attempts WHERE turn_id = ?),
                                 unpriced_calls = (SELECT COALESCE(SUM(unpriced_calls), 0) FROM session_turn_attempts WHERE turn_id = ?),
                                 llm_call_count = (SELECT COALESCE(SUM(llm_call_count), 0) FROM session_turn_attempts WHERE turn_id = ?),
                                 updated_at = datetime('now')
                             WHERE id = ?`
                        )
                        .run(...Array.from({ length: 9 }, () => Number(input.turnId)));
                }
                return { messageId, partId: Number(part.id) };
            });
            return { value };
        }
        case 'tool_part_create':
            return {
                value: transaction(database, () => createToolPartOperation(database, request)),
            };
        case 'tool_part_list': {
            const filter = toolPartFilter(request);
            const params: SQLInputValue[] = [String(request.toolKind), ...filter.params];
            const limit = request.limit === undefined ? undefined : Number(request.limit);
            const offset = request.offset === undefined ? 0 : Number(request.offset);
            const pagination =
                limit === undefined
                    ? request.offset === undefined
                        ? ''
                        : ' LIMIT -1 OFFSET ?'
                    : ' LIMIT ? OFFSET ?';
            if (limit !== undefined) params.push(limit, offset);
            else if (request.offset !== undefined) params.push(offset);
            return {
                value: read(
                    `SELECT message_parts.*, messages.session_id
                     FROM message_parts
                     INNER JOIN messages ON messages.id = message_parts.message_id
                     WHERE message_parts.type = 'tool_call'
                       AND message_parts.tool_kind = ?
                       AND ${filter.clause}
                     ORDER BY message_parts.created_at DESC, message_parts.id DESC${pagination}`,
                    params
                ).map((part) => ({
                    ...(JSON.parse(String(part.data)) as Data),
                    id: part.id,
                    session_id: part.session_id,
                    message_id: part.message_id,
                    tool_call_id: part.tool_call_id ?? null,
                    created_at: part.created_at,
                })),
            };
        }
        case 'tool_part_summaries': {
            const filter = toolPartFilter(request);
            const params: SQLInputValue[] = [String(request.toolKind), ...filter.params];
            const limit = request.limit === undefined ? undefined : Number(request.limit);
            const offset = request.offset === undefined ? 0 : Number(request.offset);
            const pagination =
                limit === undefined
                    ? request.offset === undefined
                        ? ''
                        : ' LIMIT -1 OFFSET ?'
                    : ' LIMIT ? OFFSET ?';
            if (limit !== undefined) params.push(limit, offset);
            else if (request.offset !== undefined) params.push(offset);
            const toolName =
                request.toolKind === 'builtin'
                    ? 'message_parts.tool_id'
                    : `json_extract(message_parts.data, '$."tool_name"')`;
            const serverId = request.toolKind === 'builtin' ? 'NULL' : 'message_parts.server_id';
            return {
                value: read(
                    `SELECT
                        message_parts.id,
                        message_parts.message_id,
                        messages.session_id,
                        message_parts.tool_call_id,
                        message_parts.created_at,
                        json_extract(message_parts.data, '$."status"') AS status,
                        json_extract(message_parts.data, '$."duration_ms"') AS duration_ms,
                        ${toolName} AS tool_name,
                        ${serverId} AS server_id,
                        substr(coalesce(json_extract(message_parts.data, '$."input"'), ''), 1, 200)
                            AS input_preview,
                        length(coalesce(json_extract(message_parts.data, '$."output"'), ''))
                            AS output_length
                     FROM message_parts
                     INNER JOIN messages ON messages.id = message_parts.message_id
                     WHERE message_parts.type = 'tool_call'
                       AND message_parts.tool_kind = ?
                       AND ${filter.clause}
                     ORDER BY message_parts.created_at DESC, message_parts.id DESC${pagination}`,
                    params
                ).map((row) => ({
                    ...row,
                    tool_name: row.tool_name ?? '',
                    status: row.status ?? 'pending',
                })),
            };
        }
        case 'tool_part_update': {
            const filter = toolPartFilter(request);
            const existing = read(
                `SELECT message_parts.*, messages.session_id
                 FROM message_parts
                 INNER JOIN messages ON messages.id = message_parts.message_id
                 WHERE message_parts.type = 'tool_call'
                   AND message_parts.tool_kind = ?
                   AND ${filter.clause}
                 ORDER BY message_parts.id ASC`,
                [String(request.toolKind), ...filter.params]
            );
            const payload = toolPartPayload(request.data as Data);
            let result: Data | null = null;
            for (const part of existing) {
                const merged = {
                    ...(JSON.parse(String(part.data)) as Data),
                    ...payload,
                    toolKind: String(request.toolKind),
                };
                const updated = database
                    .prepare(
                        "UPDATE message_parts SET data = ?, updated_at = datetime('now') WHERE id = ? RETURNING *"
                    )
                    .get(JSON.stringify(merged), Number(part.id)) as Data;
                if (!result) {
                    result = {
                        ...merged,
                        id: updated.id,
                        session_id: part.session_id,
                        message_id: updated.message_id,
                        tool_call_id: updated.tool_call_id ?? null,
                        created_at: updated.created_at,
                    };
                }
            }
            return { value: result };
        }
        case 'provider_list': {
            const providers = read('SELECT * FROM providers');
            const models = read('SELECT * FROM models');
            const defaultProviderId = models.find((model) => model.is_default === 1)?.provider_id;
            providers.sort((left, right) => {
                if (left.enabled !== right.enabled) {
                    return Number(right.enabled) - Number(left.enabled);
                }
                if (left.enabled === 1) {
                    const leftDefault = left.id === defaultProviderId ? 1 : 0;
                    const rightDefault = right.id === defaultProviderId ? 1 : 0;
                    if (leftDefault !== rightDefault) return rightDefault - leftDefault;
                    if (left.is_builtin !== right.is_builtin) {
                        return Number(left.is_builtin) - Number(right.is_builtin);
                    }
                }
                return (
                    providerOrder(left) - providerOrder(right) || Number(left.id) - Number(right.id)
                );
            });
            return { value: providers };
        }
        case 'provider_find':
            return {
                value:
                    read('SELECT * FROM providers WHERE id = ? LIMIT 1', [Number(request.id)])[0] ??
                    null,
            };
        case 'provider_create':
            return { value: insertRow(database, 'providers', data(request.data)) };
        case 'provider_update':
            return {
                value: updateById(database, 'providers', Number(request.id), data(request.data)),
            };
        case 'provider_delete':
            run('DELETE FROM providers WHERE id = ?', [Number(request.id)]);
            return { value: true };
        case 'model_list_with_provider': {
            const where = request.providerId === undefined ? '' : ' WHERE models.provider_id = ?';
            return {
                value: read(
                    `${MODEL_WITH_PROVIDER}${where} ORDER BY models.is_default DESC, models.id`,
                    request.providerId === undefined ? [] : [Number(request.providerId)]
                ),
            };
        }
        case 'model_find_default_with_provider':
            return {
                value:
                    read(
                        `${MODEL_WITH_PROVIDER}
                         WHERE models.is_default = 1 AND providers.enabled = 1
                         ORDER BY models.id LIMIT 1`
                    )[0] ?? null,
            };
        case 'model_find_by_provider_and_model_id':
            return {
                value:
                    read(
                        `${MODEL_WITH_PROVIDER} WHERE models.provider_id = ? AND models.model_id = ? LIMIT 1`,
                        [Number(request.providerId), String(request.modelId)]
                    )[0] ?? null,
            };
        case 'model_find_default':
            return {
                value: read('SELECT * FROM models WHERE is_default = 1 LIMIT 1')[0] ?? null,
            };
        case 'model_create':
            return { value: insertRow(database, 'models', data(request.data)) };
        case 'model_update':
            return {
                value: updateById(database, 'models', Number(request.id), data(request.data)),
            };
        case 'model_delete':
            run('DELETE FROM models WHERE id = ?', [Number(request.id)]);
            return { value: true };
        case 'model_set_default':
            transaction(database, () => {
                const target = read(
                    `SELECT models.id, providers.enabled, providers.name AS provider_name
                     FROM models
                     INNER JOIN providers ON providers.id = models.provider_id
                     WHERE models.id = ? LIMIT 1`,
                    [Number(request.modelId)]
                )[0];
                if (!target) {
                    throw Object.assign(new Error('Model not found'), {
                        code: 'model-not-found',
                    });
                }
                if (target.enabled === 0) {
                    throw Object.assign(new Error('The model provider is disabled'), {
                        code: 'provider-disabled',
                    });
                }
                run('UPDATE models SET is_default = 0 WHERE is_default = 1');
                run('UPDATE models SET is_default = 1 WHERE id = ?', [Number(request.modelId)]);
            });
            return { value: null };
        case 'model_record_upstream_metadata':
            if (Array.isArray(request.entries) && request.entries.length > 0) {
                run(UPSTREAM_METADATA_SQL, [
                    JSON.stringify(request.entries),
                    Number(request.providerId),
                ]);
            }
            return { value: null };
        case 'model_persist_catalog': {
            const result = transaction(database, () => {
                const existing = new Set(
                    read('SELECT model_id FROM models WHERE provider_id = ?', [
                        Number(request.providerId),
                    ]).map((row) => String(row.model_id))
                );
                let addedCount = 0;
                for (const model of dataList(request.models)) {
                    if (existing.has(String(model.model_id))) continue;
                    insertRow(database, 'models', {
                        provider_id: Number(request.providerId),
                        name: model.name,
                        model_id: model.model_id,
                        is_default: 0,
                    });
                    addedCount += 1;
                }
                if (Array.isArray(request.entries) && request.entries.length > 0) {
                    run(UPSTREAM_METADATA_SQL, [
                        JSON.stringify(request.entries),
                        Number(request.providerId),
                    ]);
                }
                syncAllModelsMetadata(database);
                return { addedCount };
            });
            return { value: result };
        }
        case 'model_sync_metadata':
            transaction(database, () => syncAllModelsMetadata(database));
            return { value: null };
        case 'llm_metadata_find':
            return {
                value:
                    read('SELECT * FROM llm_metadata WHERE model_id = ? LIMIT 1', [
                        String(request.modelId),
                    ])[0] ?? null,
            };
        case 'llm_metadata_insert':
            transaction(database, () => {
                for (const row of dataList(request.data)) {
                    insertRow(database, 'llm_metadata', row, 'INSERT OR IGNORE');
                }
            });
            return { value: null };
        case 'llm_metadata_clear':
            transaction(database, () => {
                run('DELETE FROM llm_metadata_aliases');
                run('DELETE FROM llm_metadata');
            });
            return { value: null };
        case 'llm_metadata_is_empty':
            return {
                value:
                    Number(
                        (read('SELECT count(*) AS count FROM llm_metadata')[0] as Data).count
                    ) === 0,
            };
        case 'llm_metadata_alias_is_empty':
            return {
                value:
                    Number(
                        (read('SELECT count(*) AS count FROM llm_metadata_aliases')[0] as Data)
                            .count
                    ) === 0,
            };
        case 'llm_metadata_find_pricing':
            return { value: findPricing(database, String(request.modelId)) };
        case 'llm_metadata_count_priced':
            return {
                value: Number(
                    (
                        read(
                            `SELECT count(*) AS count FROM llm_metadata
                             WHERE input_cost_per_million IS NOT NULL
                               AND output_cost_per_million IS NOT NULL`
                        )[0] as Data
                    ).count
                ),
            };
        case 'llm_metadata_replace':
            transaction(database, () => {
                run('DELETE FROM llm_metadata_aliases');
                run('DELETE FROM llm_metadata');
                for (const row of dataList(request.metadata)) {
                    insertRow(database, 'llm_metadata', row, 'INSERT OR IGNORE');
                }
                for (const row of dataList(request.aliases)) {
                    insertRow(database, 'llm_metadata_aliases', row, 'INSERT OR IGNORE');
                }
                syncAllModelsMetadata(database);
                if (request.markUpdatedAt) {
                    const now = new Date().toISOString();
                    upsertStatistic(database, 'model_metadata_last_updated_at', now);
                    upsertStatistic(database, 'model_metadata_last_checked_at', now);
                    if (request.sourceEtag) {
                        upsertStatistic(
                            database,
                            'model_metadata_source_etag',
                            String(request.sourceEtag)
                        );
                    }
                }
            });
            return { value: null };
        case 'llm_metadata_mark_checked':
            transaction(database, () => {
                upsertStatistic(
                    database,
                    'model_metadata_last_checked_at',
                    String(request.checkedAt)
                );
                if (request.etag) {
                    upsertStatistic(database, 'model_metadata_source_etag', String(request.etag));
                }
            });
            return { value: null };
        case 'mcp_server_list':
            return {
                value: read(
                    request.enabledOnly
                        ? 'SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name ASC'
                        : 'SELECT * FROM mcp_servers ORDER BY name ASC'
                ),
            };
        case 'mcp_server_find_by_id':
            return {
                value:
                    read('SELECT * FROM mcp_servers WHERE id = ? LIMIT 1', [
                        Number(request.id),
                    ])[0] ?? null,
            };
        case 'mcp_server_find_by_name':
            return {
                value:
                    read('SELECT * FROM mcp_servers WHERE name = ? LIMIT 1', [
                        String(request.name),
                    ])[0] ?? null,
            };
        case 'mcp_server_create':
            return { value: insertRow(database, 'mcp_servers', data(request.data)) };
        case 'mcp_server_update':
            return {
                value: updateById(database, 'mcp_servers', Number(request.id), data(request.data)),
            };
        case 'mcp_server_delete':
            run('DELETE FROM mcp_servers WHERE id = ?', [Number(request.id)]);
            return { value: null };
        case 'mcp_server_count':
            return {
                value: Number((read('SELECT count(*) AS count FROM mcp_servers')[0] as Data).count),
            };
        case 'mcp_tool_list': {
            const clauses: string[] = [];
            const params: SQLInputValue[] = [];
            if (request.serverId !== undefined) {
                clauses.push('server_id = ?');
                params.push(Number(request.serverId));
            }
            if (request.enabledOnly) clauses.push('enabled = 1');
            const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
            return {
                value: read(`SELECT * FROM mcp_tools${where} ORDER BY name ASC`, params),
            };
        }
        case 'mcp_tool_find_by_id':
            return {
                value:
                    read('SELECT * FROM mcp_tools WHERE id = ? LIMIT 1', [Number(request.id)])[0] ??
                    null,
            };
        case 'mcp_tool_find_by_server_and_name':
            return {
                value:
                    read('SELECT * FROM mcp_tools WHERE server_id = ? AND name = ? LIMIT 1', [
                        Number(request.serverId),
                        String(request.name),
                    ])[0] ?? null,
            };
        case 'mcp_tool_create':
            return { value: insertRow(database, 'mcp_tools', data(request.data)) };
        case 'mcp_tool_update':
            return {
                value: updateById(database, 'mcp_tools', Number(request.id), data(request.data)),
            };
        case 'mcp_tool_delete':
            run('DELETE FROM mcp_tools WHERE id = ?', [Number(request.id)]);
            return { value: null };
        case 'mcp_tool_delete_by_server':
            run('DELETE FROM mcp_tools WHERE server_id = ?', [Number(request.serverId)]);
            return { value: null };
        case 'mcp_tool_count':
            return {
                value: Number(
                    (
                        read(
                            request.serverId === undefined
                                ? 'SELECT count(*) AS count FROM mcp_tools'
                                : 'SELECT count(*) AS count FROM mcp_tools WHERE server_id = ?',
                            request.serverId === undefined ? [] : [Number(request.serverId)]
                        )[0] as Data
                    ).count
                ),
            };
        case 'mcp_tool_sync':
            transaction(database, () => {
                const existing = new Map(
                    read('SELECT name, enabled FROM mcp_tools WHERE server_id = ?', [
                        Number(request.serverId),
                    ]).map((row) => [String(row.name), Number(row.enabled)])
                );
                run('DELETE FROM mcp_tools WHERE server_id = ?', [Number(request.serverId)]);
                for (const definition of dataList(request.tools)) {
                    insertRow(database, 'mcp_tools', {
                        server_id: Number(request.serverId),
                        name: definition.name,
                        description: definition.description ?? null,
                        input_schema: JSON.stringify(definition.inputSchema),
                        enabled: existing.get(String(definition.name)) ?? 1,
                    });
                }
            });
            return { value: null };
        case 'built_in_tool_list':
            return {
                value: read(
                    request.enabledOnly
                        ? 'SELECT * FROM built_in_tools WHERE enabled = 1 ORDER BY display_name ASC'
                        : 'SELECT * FROM built_in_tools ORDER BY enabled DESC, display_name ASC'
                ),
            };
        case 'built_in_tool_find_by_id':
            return {
                value:
                    read('SELECT * FROM built_in_tools WHERE id = ? LIMIT 1', [
                        Number(request.id),
                    ])[0] ?? null,
            };
        case 'built_in_tool_find_by_tool_id':
            return {
                value:
                    read('SELECT * FROM built_in_tools WHERE tool_id = ? LIMIT 1', [
                        String(request.toolId),
                    ])[0] ?? null,
            };
        case 'built_in_tool_create':
            return { value: insertRow(database, 'built_in_tools', data(request.data)) };
        case 'built_in_tool_update':
            return {
                value: updateById(
                    database,
                    'built_in_tools',
                    Number(request.id),
                    data(request.data)
                ),
            };
        case 'built_in_tool_update_many': {
            const updated = transaction(database, () => {
                const rows: Data[] = [];
                for (const id of request.ids as number[]) {
                    const row = updateById(
                        database,
                        'built_in_tools',
                        Number(id),
                        data(request.data)
                    );
                    if (!row) {
                        throw Object.assign(new Error('Built-in tool not found'), {
                            code: 'built-in-tool-not-found',
                        });
                    }
                    rows.push(row);
                }
                return rows;
            });
            return { value: updated };
        }
        case 'built_in_tool_touch':
            run('UPDATE built_in_tools SET last_used_at = ? WHERE tool_id = ?', [
                String(request.lastUsedAt),
                String(request.toolId),
            ]);
            return { value: null };
        case 'built_in_tool_count_enabled':
            return {
                value: Number(
                    (
                        read(
                            'SELECT count(*) AS count FROM built_in_tools WHERE enabled = 1'
                        )[0] as Data
                    ).count
                ),
            };
        default:
            throw new Error(`Unhandled database operation in test: ${request.kind}`);
    }
}

/** Closes every database opened by `openMigratedDatabase` in the current test file. */
export function closeTestDatabases(): void {
    openDatabases.splice(0).forEach((database) => database.close());
}
