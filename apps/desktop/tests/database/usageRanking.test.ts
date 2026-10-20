import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import { getModelRanking, getSessionRanking } from '@database/queries/usageStats';
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

function seed(database: SqliteDatabase) {
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'P', 'openai', 'https://example.com', 'openai');
        INSERT INTO models (id, provider_id, name, model_id)
        VALUES (1, 1, 'Cheap Model', 'cheap'), (2, 1, 'Pricey Model', 'pricey');
        INSERT INTO sessions (id, session_id, title, model)
        VALUES (1, 's1', 'Short chat', 'cheap'), (2, 's2', 'Marathon session', 'pricey');
    `);
}

interface TurnSeed {
    id: number;
    sessionId: number;
    modelId: number;
    tokens: number;
    costMicros: number;
    durationMs: number;
    createdAt: string;
    status?: string;
}

function seedTurn(database: SqliteDatabase, turn: TurnSeed) {
    database
        .prepare(
            `INSERT INTO session_turns (
                id, session_id, model_id, task_id, prompt_snapshot_json, status,
                input_tokens, total_cost_micros, duration_ms, created_at
            ) VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`
        )
        .run(
            turn.id,
            turn.sessionId,
            turn.modelId,
            `task-${turn.id}`,
            turn.status ?? 'completed',
            turn.tokens,
            turn.costMicros,
            turn.durationMs,
            turn.createdAt
        );
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('getModelRanking', () => {
    it('orders models by tokens by default', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            sessionId: 1,
            modelId: 1,
            tokens: 500,
            costMicros: 900,
            durationMs: 1000,
            createdAt: '2026-05-01 10:00:00',
        });
        seedTurn(database, {
            id: 2,
            sessionId: 2,
            modelId: 2,
            tokens: 5000,
            costMicros: 10,
            durationMs: 2000,
            createdAt: '2026-05-01 11:00:00',
        });

        const ranked = await getModelRanking(WIDE, 'tokens');

        expect(ranked.map((item) => item.name)).toEqual(['Pricey Model', 'Cheap Model']);
        expect(ranked[0]?.tokens).toBe(5000);
    });

    it('re-orders by cost when asked', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            sessionId: 1,
            modelId: 1,
            tokens: 500,
            costMicros: 900,
            durationMs: 1000,
            createdAt: '2026-05-01 10:00:00',
        });
        seedTurn(database, {
            id: 2,
            sessionId: 2,
            modelId: 2,
            tokens: 5000,
            costMicros: 10,
            durationMs: 2000,
            createdAt: '2026-05-01 11:00:00',
        });

        const ranked = await getModelRanking(WIDE, 'cost');

        // 按费用排序时，token 少但贵的模型应该排第一
        expect(ranked[0]?.name).toBe('Cheap Model');
        expect(ranked[0]?.costMicros).toBe(900);
    });

    it('respects the limit', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            sessionId: 1,
            modelId: 1,
            tokens: 1,
            costMicros: 0,
            durationMs: 1,
            createdAt: '2026-05-01 10:00:00',
        });
        seedTurn(database, {
            id: 2,
            sessionId: 2,
            modelId: 2,
            tokens: 2,
            costMicros: 0,
            durationMs: 1,
            createdAt: '2026-05-01 11:00:00',
        });

        expect(await getModelRanking(WIDE, 'tokens', 1)).toHaveLength(1);
    });

    it('returns nothing for a range with no turns', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        expect(await getModelRanking(WIDE, 'tokens')).toEqual([]);
    });
});

describe('getSessionRanking', () => {
    it('sums the per-turn durations rather than the wall-clock span', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        // 同一个会话两轮，间隔很久，但真实耗时只有 3s
        seedTurn(database, {
            id: 1,
            sessionId: 1,
            modelId: 1,
            tokens: 100,
            costMicros: 5,
            durationMs: 1000,
            createdAt: '2026-05-01 10:00:00',
        });
        seedTurn(database, {
            id: 2,
            sessionId: 1,
            modelId: 1,
            tokens: 100,
            costMicros: 5,
            durationMs: 2000,
            createdAt: '2026-05-03 10:00:00',
        });

        const ranked = await getSessionRanking(WIDE, 'duration');

        expect(ranked).toHaveLength(1);
        // 首末时间差是 2 天，但真实对话耗时是 3 秒
        expect(ranked[0]?.durationMs).toBe(3000);
        expect(ranked[0]?.requests).toBe(2);
        expect(ranked[0]?.tokens).toBe(200);
    });

    it('carries the session title, model and last activity', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            sessionId: 2,
            modelId: 2,
            tokens: 10,
            costMicros: 1,
            durationMs: 500,
            createdAt: '2026-05-01 10:00:00',
        });

        const ranked = await getSessionRanking(WIDE, 'tokens');

        expect(ranked[0]).toMatchObject({
            name: 'Marathon session',
            subtitle: 'Pricey Model',
            lastAt: '2026-05-01 10:00:00',
        });
    });

    it('orders by duration when asked', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            sessionId: 1,
            modelId: 1,
            tokens: 9999,
            costMicros: 0,
            durationMs: 100,
            createdAt: '2026-05-01 10:00:00',
        });
        seedTurn(database, {
            id: 2,
            sessionId: 2,
            modelId: 2,
            tokens: 1,
            costMicros: 0,
            durationMs: 90_000,
            createdAt: '2026-05-01 11:00:00',
        });

        const ranked = await getSessionRanking(WIDE, 'duration');

        // token 少但跑得久的会话应排第一
        expect(ranked[0]?.name).toBe('Marathon session');
    });

    it('ignores turns outside the range', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            sessionId: 1,
            modelId: 1,
            tokens: 10,
            costMicros: 1,
            durationMs: 100,
            createdAt: '2020-01-01 10:00:00',
        });

        const ranked = await getSessionRanking({
            from: '2026-01-01 00:00:00',
            to: '2026-12-31 23:59:59',
        });

        expect(ranked).toEqual([]);
    });
});
