import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import { canUseUsageArchive, getUsageTrendFromArchive } from '@database/queries/usageStats';
import { StatisticKey } from '@database/schema';
import {
    DEFAULT_DETAIL_RETENTION_DAYS,
    pruneUsageDetail,
    rollupUsageDaily,
    runUsageMaintenance,
} from '@services/UsageService/maintenance';
import { interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');

const databaseRoot = resolve('src/database');
const journal = JSON.parse(readFileSync(`${databaseRoot}/drizzle/meta/_journal.json`, 'utf8')) as {
    entries: Array<{ tag: string }>;
};

const databases: SqliteDatabase[] = [];

function openDatabase(): SqliteDatabase {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    for (const entry of journal.entries) {
        database.exec(readFileSync(`${databaseRoot}/drizzle/${entry.tag}.sql`, 'utf8'));
    }
    return database;
}

function routeQueriesTo(database: SqliteDatabase) {
    interceptTauriInvoke((call) => {
        if (call.cmd === 'database_tx_begin') {
            database.exec('BEGIN');
            return 'test-tx';
        }
        if (call.cmd === 'database_tx_commit') {
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

function seed(database: SqliteDatabase) {
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'Magpie', 'openai-compatible', 'http://127.0.0.1:3425/v1', 'openai');
        INSERT INTO models (id, provider_id, name, model_id)
        VALUES (1, 1, 'Auto Flash', 'group/auto-deepseek-v4-1-flash');
        INSERT INTO sessions (id, session_id, title, model, provider_id)
        VALUES (1, 'session-1', 'Session', 'group/auto-deepseek-v4-1-flash', 1);
        INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'assistant');
    `);
}

/** 插入一个带用量的回合 */
function seedTurn(
    database: SqliteDatabase,
    options: {
        id: number;
        createdAt: string;
        status?: string;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        costMicros?: number;
        unpricedCalls?: number;
        ttftMs?: number | null;
        durationMs?: number | null;
        modelId?: number;
    }
) {
    database
        .prepare(
            `INSERT INTO session_turns (
                id, session_id, model_id, task_id, prompt_snapshot_json, status,
                created_at, input_tokens, output_tokens, cache_read_tokens,
                total_cost_micros, unpriced_calls, ttft_ms, duration_ms
            ) VALUES (?, 1, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            options.id,
            options.modelId ?? 1,
            `task-${options.id}`,
            options.status ?? 'completed',
            options.createdAt,
            options.inputTokens ?? 0,
            options.outputTokens ?? 0,
            options.cacheReadTokens ?? 0,
            options.costMicros ?? 0,
            options.unpricedCalls ?? 0,
            options.ttftMs ?? null,
            options.durationMs ?? null
        );
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('rollupUsageDaily', () => {
    it('groups turns by day, model, and provider', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            createdAt: '2026-05-01 10:00:00',
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 900,
            costMicros: 42,
            ttftMs: 800,
            durationMs: 2000,
        });
        seedTurn(database, {
            id: 2,
            createdAt: '2026-05-01 11:00:00',
            inputTokens: 50,
            outputTokens: 10,
            ttftMs: 400,
            durationMs: 1000,
        });
        seedTurn(database, { id: 3, createdAt: '2026-05-02 09:00:00', status: 'failed' });

        await rollupUsageDaily();

        const rows = database
            .prepare(
                `SELECT day, model_name, provider_name, request_count, success_count,
                        input_tokens, output_tokens, cache_read_tokens, total_cost_micros,
                        sum_ttft_ms, sum_duration_ms, ttft_sample_count
                 FROM usage_daily_rollups ORDER BY day`
            )
            .all() as Array<Record<string, unknown>>;

        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            day: '2026-05-01',
            model_name: 'Auto Flash',
            provider_name: 'Magpie',
            request_count: 2,
            success_count: 2,
            input_tokens: 150,
            output_tokens: 30,
            cache_read_tokens: 900,
            total_cost_micros: 42,
            sum_ttft_ms: 1200,
            sum_duration_ms: 3000,
            // 只有带 ttft 的回合参与均值，不能把 null 算成 0
            ttft_sample_count: 2,
        });
        expect(rows[1]).toMatchObject({
            day: '2026-05-02',
            request_count: 1,
            success_count: 0,
            input_tokens: 0,
        });
    });

    it('keeps ttft sample count at zero when no turn reported a first token', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, { id: 1, createdAt: '2026-05-01 10:00:00' });

        await rollupUsageDaily();

        const row = database.prepare('SELECT ttft_sample_count FROM usage_daily_rollups').get() as {
            ttft_sample_count: number;
        };
        expect(row.ttft_sample_count).toBe(0);
    });

    it('is idempotent across repeated runs', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            createdAt: '2026-05-01 10:00:00',
            inputTokens: 100,
            costMicros: 7,
        });

        await rollupUsageDaily();
        await rollupUsageDaily();

        const row = database
            .prepare('SELECT count(*) AS n, sum(input_tokens) AS tokens FROM usage_daily_rollups')
            .get() as { n: number; tokens: number };
        expect(row).toEqual({ n: 1, tokens: 100 });
    });

    it('recomputes a day when its turns change', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, { id: 1, createdAt: '2026-05-01 10:00:00', inputTokens: 100 });

        await rollupUsageDaily();

        database.exec('UPDATE session_turns SET input_tokens = 250 WHERE id = 1');
        await rollupUsageDaily();

        const row = database.prepare('SELECT input_tokens FROM usage_daily_rollups').get() as {
            input_tokens: number;
        };
        expect(row.input_tokens).toBe(250);
    });

    it('falls back to a placeholder when the model or provider is gone', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        database.exec('PRAGMA foreign_keys = OFF');
        seedTurn(database, { id: 1, createdAt: '2026-05-01 10:00:00', modelId: 999 });

        await rollupUsageDaily();

        const row = database
            .prepare('SELECT model_name, provider_name FROM usage_daily_rollups')
            .get() as { model_name: string; provider_name: string };
        expect(row).toEqual({ model_name: '—', provider_name: '—' });
    });
});

describe('pruneUsageDetail', () => {
    function seedCallPart(database: SqliteDatabase, id: number, createdAt: string) {
        database
            .prepare(
                `INSERT INTO message_parts (id, message_id, type, content, sort_order, created_at)
                 VALUES (?, 1, 'llm_call', '', ?, ?)`
            )
            .run(id, id, createdAt);
    }

    it('does nothing when retention is disabled', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedCallPart(database, 1, '2000-01-01 00:00:00');

        expect(await pruneUsageDetail(0)).toBe(0);
        expect(await pruneUsageDetail(-1)).toBe(0);
        expect(await pruneUsageDetail(DEFAULT_DETAIL_RETENTION_DAYS)).toBe(0);

        const row = database.prepare('SELECT count(*) AS n FROM message_parts').get() as {
            n: number;
        };
        expect(row.n).toBe(1);
    });

    it('removes only expired call parts and leaves text parts alone', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedCallPart(database, 1, '2000-01-01 00:00:00');
        seedCallPart(database, 2, '2999-01-01 00:00:00');
        database.exec(
            `INSERT INTO message_parts (id, message_id, type, content, sort_order, created_at)
             VALUES (3, 1, 'text', '旧正文', 5, '2000-01-01 00:00:00')`
        );

        const pruned = await pruneUsageDetail(30);

        expect(pruned).toBe(1);
        const remaining = database
            .prepare('SELECT id, type FROM message_parts ORDER BY id')
            .all() as Array<{ id: number; type: string }>;
        expect(remaining).toEqual([
            { id: 2, type: 'llm_call' },
            { id: 3, type: 'text' },
        ]);
    });
});

describe('getUsageTrendFromArchive', () => {
    it('folds a day into one point and keeps its per-model segments', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            createdAt: '2026-05-01 10:00:00',
            inputTokens: 100,
            outputTokens: 10,
            costMicros: 5,
        });
        seedTurn(database, {
            id: 2,
            createdAt: '2026-05-01 12:00:00',
            inputTokens: 200,
            outputTokens: 20,
            costMicros: 7,
        });

        await rollupUsageDaily();
        const archive = await getUsageTrendFromArchive();

        expect(archive.bucket).toBe('day');
        expect(archive.points).toHaveLength(1);
        // 图表需要逐段堆叠，所以一天可能有多个 segment
        expect(archive.points[0]).toMatchObject({
            key: '2026-05-01',
            requests: 2,
            tokens: 330,
            costMicros: 12,
        });
        const segmentTotal = archive.points[0]!.segments.reduce(
            (sum, segment) => sum + segment.tokens,
            0
        );
        expect(segmentTotal).toBe(330);
    });

    it('agrees with the live trend when nothing has been pruned', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            createdAt: '2026-05-01 10:00:00',
            inputTokens: 100,
            outputTokens: 10,
            costMicros: 5,
        });

        await rollupUsageDaily();
        const archive = await getUsageTrendFromArchive();

        const live = database
            .prepare(
                `SELECT date(created_at) AS key, count(*) AS requests,
                        sum(input_tokens) AS input, sum(output_tokens) AS output
                 FROM session_turns GROUP BY key`
            )
            .all() as Array<{ key: string; requests: number; input: number; output: number }>;

        expect(archive.points).toHaveLength(live.length);
        expect(archive.points[0]).toMatchObject({ key: live[0]!.key, requests: live[0]!.requests });
    });
});

describe('canUseUsageArchive', () => {
    const open = {
        from: '1970-01-01 00:00:00',
        to: '9999-12-31 23:59:59',
    };

    it('allows the archive when nothing narrows the query', () => {
        expect(canUseUsageArchive(open)).toBe(true);
        expect(canUseUsageArchive({ ...open, search: '   ' })).toBe(true);
    });

    it('refuses the archive for any id- or status-based filter', () => {
        expect(canUseUsageArchive({ ...open, modelIds: [1] })).toBe(false);
        expect(canUseUsageArchive({ ...open, providerIds: [1] })).toBe(false);
        expect(canUseUsageArchive({ ...open, statuses: ['failed'] })).toBe(false);
        expect(canUseUsageArchive({ ...open, onlyFailed: true })).toBe(false);
        expect(canUseUsageArchive({ ...open, onlyRetried: true })).toBe(false);
        expect(canUseUsageArchive({ ...open, search: 'claude' })).toBe(false);
    });
});

describe('runUsageMaintenance', () => {
    it('rolls up and records the run time', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, { id: 1, createdAt: '2026-05-01 10:00:00', inputTokens: 10 });

        await runUsageMaintenance();

        const rollups = database.prepare('SELECT count(*) AS n FROM usage_daily_rollups').get() as {
            n: number;
        };
        expect(rollups.n).toBe(1);

        const stamp = database
            .prepare('SELECT value FROM statistics WHERE key = ?')
            .get(StatisticKey.USAGE_MAINTENANCE_RUN_AT) as { value: string } | undefined;
        expect(stamp?.value).toBeTruthy();
    });

    it('skips the second run inside the throttle window', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, { id: 1, createdAt: '2026-05-01 10:00:00', inputTokens: 10 });

        await runUsageMaintenance();
        seedTurn(database, { id: 2, createdAt: '2026-05-02 10:00:00', inputTokens: 20 });
        await runUsageMaintenance();

        // 第二次被节流跳过，所以新回合还没进入汇总
        const rollups = database.prepare('SELECT count(*) AS n FROM usage_daily_rollups').get() as {
            n: number;
        };
        expect(rollups.n).toBe(1);
    });

    it('re-runs once the recorded timestamp is stale', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, { id: 1, createdAt: '2026-05-01 10:00:00', inputTokens: 10 });

        database
            .prepare('INSERT INTO statistics (key, value) VALUES (?, ?)')
            .run(StatisticKey.USAGE_MAINTENANCE_RUN_AT, '2000-01-01T00:00:00.000Z');

        seedTurn(database, { id: 2, createdAt: '2026-05-02 10:00:00', inputTokens: 20 });
        await runUsageMaintenance();

        const rollups = database.prepare('SELECT count(*) AS n FROM usage_daily_rollups').get() as {
            n: number;
        };
        expect(rollups.n).toBe(2);
    });

    it('swallows database failures instead of breaking startup', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        database.exec('DROP TABLE usage_daily_rollups');

        await expect(runUsageMaintenance()).resolves.toBeUndefined();
    });
});
