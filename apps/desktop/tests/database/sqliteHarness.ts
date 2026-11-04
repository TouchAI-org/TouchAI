import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import { interceptTauriInvoke } from '@tests/utils/tauri';

import { expandModelIdCandidates } from '@/domain/models/modelIdCandidates';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');

const databaseRoot = resolve('src/database');
const journal = JSON.parse(readFileSync(`${databaseRoot}/drizzle/meta/_journal.json`, 'utf8')) as {
    entries: Array<{ tag: string }>;
};
const openDatabases: SqliteDatabase[] = [];

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
    interceptTauriInvoke((call) => {
        const operation = routeDatabaseOperation(database, call);
        if (operation) {
            return operation.value;
        }
        if (call.cmd === 'database_tx_begin') {
            database.exec('BEGIN');
            return 'test-tx';
        }
        if (call.cmd === 'database_tx_commit') {
            options.beforeCommit?.();
            database.exec('COMMIT');
            return null;
        }
        if (call.cmd === 'database_tx_rollback') {
            database.exec('ROLLBACK');
            return null;
        }
        if (call.cmd !== 'database_query' && call.cmd !== 'database_tx_query') return undefined;

        const { request } = call.payload as {
            request: { sql: string; params: SQLInputValue[]; method: string };
        };
        const statement = database.prepare(request.sql);
        if (request.method === 'run') {
            const result = statement.run(...(request.params ?? []));
            return {
                rows: [],
                rowsAffected: Number(result.changes),
                lastInsertId: Number(result.lastInsertRowid),
            };
        }
        return {
            rows: statement.all(...(request.params ?? [])),
            rowsAffected: 0,
            lastInsertId: null,
        };
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
    database.exec('BEGIN');
    try {
        const result = callback();
        database.exec('COMMIT');
        return result;
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
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
        case 'quick_search_upsert':
            if (!request.queryNorm || !request.pathNorm) return { value: null };
            run(
                `INSERT INTO quick_search_click_stats (query_norm, path_norm, click_count)
                 VALUES (?, ?, 1)
                 ON CONFLICT(query_norm, path_norm) DO UPDATE SET
                   click_count = CASE
                     WHEN quick_search_click_stats.click_count >= ? THEN ?
                     ELSE quick_search_click_stats.click_count + 1
                   END,
                   updated_at = datetime('now')`,
                [
                    String(request.queryNorm),
                    String(request.pathNorm),
                    Number(request.maxClickCount),
                    Number(request.maxClickCount),
                ]
            );
            return { value: null };
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
                    throw Object.assign(new Error(String(target.provider_name)), {
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
                        throw Object.assign(
                            new Error(`Built-in tool not found after update: ${id}`),
                            { code: 'built-in-tool-not-found' }
                        );
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
