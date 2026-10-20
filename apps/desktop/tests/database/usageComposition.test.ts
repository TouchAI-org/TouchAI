import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import { getUsageComposition } from '@database/queries/usageStats';
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
const WIDE = { from: '1970-01-01 00:00:00', to: '9999-12-31 23:59:59' };

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

/** 最小链路：provider / model / session / message / turn */
function seed(database: SqliteDatabase) {
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'P', 'openai', 'https://example.com', 'openai');
        INSERT INTO models (id, provider_id, name, model_id) VALUES (1, 1, 'M', 'm');
        INSERT INTO sessions (id, session_id, title, model) VALUES (1, 's1', 'Chat', 'm');
        INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'assistant');
    `);
}

function seedTurn(
    database: SqliteDatabase,
    options: {
        id: number;
        breakdown?: Record<string, unknown>;
        outputTokens?: number;
        inputTokens?: number;
        cacheReadTokens?: number;
        durationMs?: number;
        createdAt?: string;
    }
) {
    database
        .prepare(
            `INSERT INTO session_turns (
                id, session_id, model_id, task_id, prompt_snapshot_json, status,
                prompt_breakdown_json, output_tokens, input_tokens, cache_read_tokens,
                duration_ms, created_at
            ) VALUES (?, 1, 1, ?, '{}', 'completed', ?, ?, ?, ?, ?, ?)`
        )
        .run(
            options.id,
            `task-${options.id}`,
            options.breakdown ? JSON.stringify(options.breakdown) : null,
            options.outputTokens ?? 0,
            options.inputTokens ?? 0,
            options.cacheReadTokens ?? 0,
            options.durationMs ?? 0,
            options.createdAt ?? '2026-05-01 10:00:00'
        );
}

function seedLlmCall(
    database: SqliteDatabase,
    timing: { ttftMs: number | null; firstTextMs: number | null; flowMs: number | null },
    createdAt = '2026-05-01 10:00:00'
) {
    const data = JSON.stringify({ timing });
    database
        .prepare(
            `INSERT INTO message_parts (message_id, type, content, data, sort_order, created_at)
             VALUES (1, 'llm_call', '', ?, (SELECT coalesce(max(sort_order), 0) + 1 FROM message_parts), ?)`
        )
        .run(data, createdAt);
}

function seedPart(
    database: SqliteDatabase,
    type: 'text' | 'reasoning' | 'tool_call',
    content: string,
    data = '{}',
    createdAt = '2026-05-01 10:00:00'
) {
    database
        .prepare(
            `INSERT INTO message_parts (message_id, type, content, data, sort_order, created_at)
             VALUES (1, ?, ?, ?, (SELECT coalesce(max(sort_order), 0) + 1 FROM message_parts), ?)`
        )
        .run(type, content, data, createdAt);
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('getUsageComposition tokens', () => {
    it('splits the prompt breakdown into content categories', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            breakdown: {
                fragments: { platform: 4000, policy: 400 },
                builtinToolDefinitions: 1200,
                mcpToolDefinitions: 800,
                userPrompt: 400,
                attachments: 0,
            },
            outputTokens: 1000,
        });

        const result = await getUsageComposition(WIDE);
        const byKey = new Map(result.tokens.segments.map((segment) => [segment.key, segment]));

        expect(byKey.get('systemPrompt')?.value).toBeGreaterThan(0);
        expect(byKey.get('toolDefinitions')?.value).toBeGreaterThan(0);
        expect(byKey.get('userPrompt')?.value).toBeGreaterThan(0);
        // 输出是供应商实测值，不标 ≈
        expect(byKey.get('output')).toMatchObject({ value: 1000, estimated: false });
        expect(byKey.get('systemPrompt')?.estimated).toBe(true);
    });

    it('hides categories with no data instead of drawing zero-width slices', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            breakdown: { fragments: { platform: 4000 }, userPrompt: 10 },
            outputTokens: 50,
        });

        const result = await getUsageComposition(WIDE);

        expect(result.tokens.segments.map((segment) => segment.key)).not.toContain('injections');
        expect(result.tokens.segments.map((segment) => segment.key)).not.toContain('toolResults');
    });

    it('counts conversation and tool output from stored part lengths', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, { id: 1, breakdown: { fragments: { platform: 100 } } });
        seedPart(database, 'text', 'a'.repeat(400));
        seedPart(database, 'reasoning', 'b'.repeat(200));
        seedPart(database, 'tool_call', '', JSON.stringify({ output: 'c'.repeat(800) }));

        const result = await getUsageComposition(WIDE);
        const byKey = new Map(result.tokens.segments.map((segment) => [segment.key, segment]));

        expect(byKey.get('conversation')?.value).toBeGreaterThan(0);
        expect(byKey.get('toolResults')?.value).toBeGreaterThan(
            byKey.get('conversation')?.value ?? 0
        );
    });

    it('reports the cache read share separately from the content split', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            breakdown: { fragments: { platform: 400 } },
            inputTokens: 100,
            cacheReadTokens: 900,
        });

        const result = await getUsageComposition(WIDE);

        // 缓存读取是计费口径，不进内容构成，只作图注
        expect(result.cacheReadShare).toBeCloseTo(0.9, 5);
        expect(result.tokens.segments.map((segment) => segment.key)).not.toContain('cacheRead');
    });
});

describe('getUsageComposition timing', () => {
    it('splits wait, thinking, reply and tool run from real timings', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, { id: 1, durationMs: 10_000 });
        seedLlmCall(database, { ttftMs: 1000, firstTextMs: 1500, flowMs: 3000 });
        seedPart(database, 'tool_call', '', JSON.stringify({ duration_ms: 2000 }));

        const result = await getUsageComposition(WIDE);
        const byKey = new Map(result.timing.segments.map((segment) => [segment.key, segment]));

        expect(byKey.get('wait')?.value).toBe(1000);
        expect(byKey.get('think')?.value).toBe(500);
        expect(byKey.get('reply')?.value).toBe(3000);
        expect(byKey.get('tool')?.value).toBe(2000);
        // 剩余归入参数与间隙，且总量等于活跃时长
        expect(byKey.get('other')?.value).toBe(3500);
        expect(result.timing.totalMs).toBe(10_000);
        expect(result.timing.segments.reduce((sum, segment) => sum + segment.value, 0)).toBe(
            10_000
        );
    });

    it('never reports a negative remainder when parts overlap the turn duration', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        // 调用与工具耗时之和超过回合耗时（并行工具、计时口径差异）
        seedTurn(database, { id: 1, durationMs: 1000 });
        seedLlmCall(database, { ttftMs: 900, firstTextMs: 1500, flowMs: 3000 });
        seedPart(database, 'tool_call', '', JSON.stringify({ duration_ms: 500 }));

        const result = await getUsageComposition(WIDE);
        const other = result.timing.segments.find((segment) => segment.key === 'other');

        expect(other).toBeUndefined();
        expect(result.timing.segments.every((segment) => segment.value >= 0)).toBe(true);
    });

    it('returns empty segments for a range without usage', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const result = await getUsageComposition(WIDE);

        expect(result.tokens.segments).toEqual([]);
        expect(result.timing.segments).toEqual([]);
        expect(result.timing.totalMs).toBe(0);
        expect(result.cacheReadShare).toBe(0);
    });
});
