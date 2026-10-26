import type { SQLInputValue } from 'node:sqlite';

import {
    clearLlmMetadata,
    findModelPricing,
    insertLlmMetadata,
    isLlmMetadataAliasEmpty,
    isLlmMetadataEmpty,
} from '@database/queries/llmMetadata';
import { interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

import { openMigratedDatabase } from './sqliteHarness';

/**
 * The metadata cache drives the cost shown after a request and the reasoning levels a model
 * offers. A tier parsed wrongly under-charges a long call; an empty-looking cache hides a
 * feature until the app refetches.
 */
const databases: ReturnType<typeof openMigratedDatabase>[] = [];

function openDatabase() {
    const database = openMigratedDatabase();
    databases.push(database);
    return database;
}

function routeQueriesTo(database: ReturnType<typeof openMigratedDatabase>) {
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
            const result = statement.run(...request.params);
            return {
                rows: [],
                rowsAffected: Number(result.changes),
                lastInsertId: Number(result.lastInsertRowid),
            };
        }
        return { rows: statement.all(...request.params), rowsAffected: 0, lastInsertId: null };
    });
}

function metadata(overrides: Record<string, unknown> = {}) {
    // Only the columns the real table has; a wrong key here would fail the insert.
    return {
        model_id: 'gpt-4o',
        name: 'GPT-4o',
        modalities: '["text"]',
        input_cost_per_million: '2.5',
        output_cost_per_million: '10',
        cache_read_cost_per_million: '1.25',
        cache_write_cost_per_million: '0',
        reasoning_cost_per_million: '10',
        cost_currency: 'USD',
        cost_tiers: null,
        ...overrides,
    } as never;
}

afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
});

describe('user gets a tiered price for a long call', () => {
    it('user gets the higher tier applied when the input passes its threshold', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        await insertLlmMetadata([
            metadata({
                cost_tiers: JSON.stringify([
                    {
                        above: 200_000,
                        input: 5,
                        output: 15,
                        cacheRead: 2,
                        cacheWrite: 0,
                        reasoning: 15,
                    },
                ]),
            }),
        ]);

        const pricing = await findModelPricing('gpt-4o');

        // A long context costs more per token, and the UI shows that price.
        expect(pricing?.tiers).toHaveLength(1);
        expect(pricing?.tiers[0]).toMatchObject({
            above: 200_000,
            inputPerMillion: '5',
            outputPerMillion: '15',
        });
    });

    it('user gets the tiers ordered by threshold regardless of how they were stored', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        await insertLlmMetadata([
            metadata({
                cost_tiers: JSON.stringify([
                    { above: 500_000, input: 8, output: 20 },
                    { above: 200_000, input: 5, output: 15 },
                ]),
            }),
        ]);

        const pricing = await findModelPricing('gpt-4o');

        // The caller walks the tiers in order and takes the first one that fits.
        expect(pricing?.tiers.map((tier) => tier.above)).toEqual([200_000, 500_000]);
    });

    it('user gets a tier with no price for one side falling back to the base price', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        await insertLlmMetadata([
            metadata({
                cost_tiers: JSON.stringify([{ above: 200_000, input: 5 }]),
            }),
        ]);

        const pricing = await findModelPricing('gpt-4o');

        // An empty string tells the caller to fall back, rather than a wrong zero.
        expect(pricing?.tiers[0]).toMatchObject({
            inputPerMillion: '5',
            outputPerMillion: '',
        });
    });

    it('user gets a tier dropped when its threshold is not a positive number', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        await insertLlmMetadata([
            metadata({
                cost_tiers: JSON.stringify([
                    { above: 0, input: 5 },
                    { above: 'soon', input: 6 },
                    { above: 200_000, input: 7 },
                ]),
            }),
        ]);

        const pricing = await findModelPricing('gpt-4o');

        // A tier the caller cannot apply must not shift the ones that are valid.
        expect(pricing?.tiers.map((tier) => tier.above)).toEqual([200_000]);
    });

    it('user gets no tiers when the stored value is not valid JSON', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        await insertLlmMetadata([metadata({ cost_tiers: '{not json' })]);

        const pricing = await findModelPricing('gpt-4o');

        // A corrupt cache entry must degrade to a flat price, not break every cost display.
        expect(pricing?.tiers).toEqual([]);
        expect(pricing?.inputPerMillion).toBe('2.5');
    });

    it('user gets no tiers when the stored value is not an array', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        await insertLlmMetadata([metadata({ cost_tiers: '{"above":1}' })]);

        const pricing = await findModelPricing('gpt-4o');

        expect(pricing?.tiers).toEqual([]);
    });

    it('user gets an empty tier list for a model with no tiers stored', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        await insertLlmMetadata([metadata()]);

        const pricing = await findModelPricing('gpt-4o');

        expect(pricing?.tiers).toEqual([]);
    });
});

describe('user starts the app with an empty metadata cache', () => {
    it('user gets the cache reported empty before the first download', async () => {
        const database = openDatabase();
        routeQueriesTo(database);

        await expect(isLlmMetadataEmpty()).resolves.toBe(true);
        await expect(isLlmMetadataAliasEmpty()).resolves.toBe(true);
    });

    it('user gets the cache reported populated once models are stored', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        await insertLlmMetadata([metadata()]);

        await expect(isLlmMetadataEmpty()).resolves.toBe(false);
    });

    it('user gets the alias table reported empty on a cache written by an older version', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        await insertLlmMetadata([metadata()]);

        // Models exist but no aliases: the app has to fetch the catalogue again.
        await expect(isLlmMetadataEmpty()).resolves.toBe(false);
        await expect(isLlmMetadataAliasEmpty()).resolves.toBe(true);
    });
});

describe('user gets the cache refreshed', () => {
    it('user gets the second copy of a model id ignored rather than duplicated', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        await insertLlmMetadata([metadata({ name: 'First' })]);
        await insertLlmMetadata([metadata({ name: 'Second' })]);

        const rows = database.prepare('SELECT COUNT(*) AS n FROM llm_metadata').get() as {
            n: number;
        };
        // The catalogue is refetched on every launch; duplicates would grow the table forever.
        expect(rows.n).toBe(1);
    });

    it('user gets nothing written when there is nothing to insert', async () => {
        const database = openDatabase();
        routeQueriesTo(database);

        await insertLlmMetadata([]);

        await expect(isLlmMetadataEmpty()).resolves.toBe(true);
    });

    it('user gets the cache emptied so a refetch starts clean', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        await insertLlmMetadata([metadata()]);

        await clearLlmMetadata();

        await expect(isLlmMetadataEmpty()).resolves.toBe(true);
        await expect(isLlmMetadataAliasEmpty()).resolves.toBe(true);
    });
});
