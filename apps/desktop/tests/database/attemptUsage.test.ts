import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import { db } from '@database';
import { updateSessionTurnAttemptUsage } from '@database/queries/sessionTurnAttempts';
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
        INSERT INTO session_turns (id, session_id, model_id, task_id, prompt_snapshot_json)
        VALUES (1, 1, 1, 't1', '{}');
        INSERT INTO session_turn_attempts (id, turn_id, attempt_index, checkpoint_json, delivery_manifest_json)
        VALUES (1, 1, 1, '{}', '{}');
    `);
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('updateSessionTurnAttemptUsage', () => {
    it('writes every usage column including reasoning tokens', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await updateSessionTurnAttemptUsage({
            id: 1,
            usagePatch: {
                input_tokens: 100,
                output_tokens: 50,
                cache_read_tokens: 900,
                cache_write_tokens: 0,
                reasoning_tokens: 42,
                total_cost_micros: 7,
                unpriced_calls: 0,
                ttft_ms: 800,
                llm_call_count: 1,
            },
            database: db,
        });

        const row = database
            .prepare(
                `SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                        reasoning_tokens, total_cost_micros, unpriced_calls, ttft_ms, llm_call_count
                 FROM session_turn_attempts WHERE id = 1`
            )
            .get() as Record<string, unknown>;

        expect(row).toEqual({
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 900,
            cache_write_tokens: 0,
            // 关键：这个列历史上被静默丢掉，导致用量页的「其中推理」恒为 0
            reasoning_tokens: 42,
            total_cost_micros: 7,
            unpriced_calls: 0,
            ttft_ms: 800,
            llm_call_count: 1,
        });
    });
});
