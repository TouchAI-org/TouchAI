import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import { db } from '@database';
import type { PersistedCall } from '@services/UsageService';
import { sumUsage } from '@services/UsageService';
import { insertLlmCallParts } from '@services/UsageService/insertLlmCallParts';
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
        VALUES (1, 'P', 'openai', 'https://example.com', 'openai');
        INSERT INTO models (id, provider_id, name, model_id)
        VALUES (1, 1, 'M', 'm');
        INSERT INTO sessions (id, session_id, title, model)
        VALUES (1, 's1', 'S', 'm');
        INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'assistant');
        INSERT INTO session_turns (id, session_id, model_id, task_id, prompt_snapshot_json)
        VALUES (1, 1, 1, 't1', '{}');
    `);
}

function call(reasoning: number, output: number): PersistedCall {
    return {
        record: {
            iteration: 0,
            modelId: 1,
            modelName: 'm',
            providerId: 1,
            providerName: 'P',
            usage: {
                inputTokens: 100,
                outputTokens: output,
                cacheReadTokens: 10,
                cacheWriteTokens: 0,
                reasoningTokens: reasoning,
            },
            timing: { ttftMs: 500, firstTextMs: 520, flowMs: 100, durationMs: 1200 },
            finishReason: 'stop',
            toolArgumentsError: undefined,
            toolCallsInStep: 0,
            toolArgumentErrors: 0,
        },
        cost: {
            inputCostMicros: 1,
            outputCostMicros: 2,
            cacheReadCostMicros: 0,
            cacheWriteCostMicros: 0,
            reasoningCostMicros: 3,
            totalCostMicros: 6,
            currency: 'USD',
            pricingModel: 'm',
            appliedTierAbove: null,
            priced: true,
        },
    } as PersistedCall;
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('when usage is summed across calls', () => {
    it('user sees reasoning tokens added up across calls', () => {
        const usage = sumUsage([call(100, 300), call(50, 200)]);

        expect(usage.reasoningTokens).toBe(150);
        expect(usage.outputTokens).toBe(500);
    });
});

describe('when a model call stores its usage', () => {
    it('user sees the reasoning token count in the usage ledger', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await insertLlmCallParts(1, [call(120, 400)], db, 1);

        const row = database
            .prepare(
                `SELECT json_extract(data, '$.usage.reasoningTokens') AS reasoning,
                        json_extract(data, '$.costMicros') AS cost
                 FROM message_parts WHERE type = 'llm_call'`
            )
            .get() as { reasoning: number; cost: number };

        expect(row.reasoning).toBe(120);
        expect(row.cost).toBe(6);
    });
});
