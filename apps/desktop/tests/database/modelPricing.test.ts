import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import { findModelPricing } from '@database/queries/llmMetadata';
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

function insertMetadata(
    database: SqliteDatabase,
    modelId: string,
    prices: { input: string | null; output: string | null; cacheRead?: string | null }
) {
    database
        .prepare(
            `INSERT INTO llm_metadata (
                model_id, name, modalities, input_cost_per_million, output_cost_per_million,
                cache_read_cost_per_million, cost_currency
            ) VALUES (?, ?, '{}', ?, ?, ?, 'USD')`
        )
        .run(modelId, modelId, prices.input, prices.output, prices.cacheRead ?? null);
}

function insertAlias(database: SqliteDatabase, alias: string, modelId: string) {
    database
        .prepare('INSERT INTO llm_metadata_aliases (alias, model_id) VALUES (?, ?)')
        .run(alias, modelId);
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('findModelPricing', () => {
    it('matches a model id that is present verbatim', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        insertMetadata(database, 'claude-sonnet-4-5', { input: '3', output: '15' });

        const pricing = await findModelPricing('claude-sonnet-4-5');

        expect(pricing).toMatchObject({ inputPerMillion: '3', outputPerMillion: '15' });
    });

    it('matches through a stripped route prefix', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        insertMetadata(database, 'deepseek-v4-flash', { input: '0.22', output: '0.66' });

        const pricing = await findModelPricing('auto-deepseek-v4-flash');

        expect(pricing?.inputPerMillion).toBe('0.22');
    });

    it('matches through the alias table for a relay spelling', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        // 上游记录用的是点号版本号，中转用连字符
        insertMetadata(database, 'deepseek/deepseek-v4.1-flash', {
            input: '0.15',
            output: '0.6',
        });
        insertAlias(database, 'deepseek-v4-1-flash', 'deepseek/deepseek-v4.1-flash');

        const pricing = await findModelPricing('group/auto-deepseek-v4-1-flash');

        // 只查 llm_metadata.model_id 会返回 null，导致整条成本链路归零
        expect(pricing).toMatchObject({
            modelId: 'deepseek/deepseek-v4.1-flash',
            inputPerMillion: '0.15',
            outputPerMillion: '0.6',
        });
    });

    it('prefers a direct hit over an alias hit', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        insertMetadata(database, 'deepseek-v4-flash', { input: '1', output: '2' });
        insertMetadata(database, 'deepseek/deepseek-v4-flash', { input: '9', output: '9' });
        insertAlias(database, 'deepseek-v4-flash', 'deepseek/deepseek-v4-flash');

        const pricing = await findModelPricing('deepseek-v4-flash');

        expect(pricing?.inputPerMillion).toBe('1');
    });

    it('returns null when the model has no price at all', async () => {
        const database = openDatabase();
        routeQueriesTo(database);

        await expect(findModelPricing('unknown-model')).resolves.toBeNull();
    });

    it('skips records that only carry one side of the price', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        // 只有 input 没有 output：算出来的成本会低估，不能当定价用
        insertMetadata(database, 'half-priced', { input: '5', output: null });

        await expect(findModelPricing('half-priced')).resolves.toBeNull();
    });

    it('fills missing cache prices with zero instead of dropping the record', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        insertMetadata(database, 'no-cache-price', { input: '1', output: '2' });

        const pricing = await findModelPricing('no-cache-price');

        expect(pricing).toMatchObject({
            inputPerMillion: '1',
            cacheReadPerMillion: '0',
            cacheWritePerMillion: '0',
        });
    });

    it('treats a genuine zero price as priced', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        insertMetadata(database, 'free-model', { input: '0', output: '0' });

        const pricing = await findModelPricing('free-model');

        // 0 是「免费」，不是「未知」
        expect(pricing).toMatchObject({ inputPerMillion: '0', outputPerMillion: '0' });
    });
});
