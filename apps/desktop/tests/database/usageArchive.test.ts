import type { SQLInputValue } from 'node:sqlite';

import { canUseUsageArchive, getUsageTrendFromArchive } from '@database/queries/usageStats';
import { interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

import { openMigratedDatabase } from './sqliteHarness';

/**
 * Once old request rows are pruned, the only remaining history is the daily rollup. Reading it
 * wrongly either shows an empty chart for data the app still has, or shows a filtered chart that
 * silently ignores the filter.
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

afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
});

describe('user opens the usage chart after old data was pruned', () => {
    it('user gets the archived days with their request and token totals', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO usage_daily_rollups
                (day, model_name, provider_name, request_count, input_tokens, output_tokens,
                 cache_read_tokens, cache_write_tokens, total_cost_micros)
                VALUES ('2026-01-01', 'gpt-4o', 'openai', 3, 100, 50, 10, 0, 2500),
                       ('2026-01-02', 'gpt-4o', 'openai', 2, 200, 80, 0, 0, 4000);
        `);

        const trend = await getUsageTrendFromArchive();

        expect(trend.bucket).toBe('day');
        expect(trend.points.map((point) => point.key)).toEqual(['2026-01-01', '2026-01-02']);
        expect(trend.points[0]).toMatchObject({ requests: 3, tokens: 160, costMicros: 2500 });
    });

    it('user gets the models of one day combined into one point', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO usage_daily_rollups
                (day, model_name, provider_name, request_count, input_tokens, output_tokens,
                 cache_read_tokens, cache_write_tokens, total_cost_micros)
                VALUES ('2026-01-01', 'gpt-4o', 'openai', 3, 100, 50, 0, 0, 2500),
                       ('2026-01-01', 'claude', 'anthropic', 1, 40, 20, 0, 0, 1000);
        `);

        const trend = await getUsageTrendFromArchive();

        // One bar per day, split into segments by model.
        expect(trend.points).toHaveLength(1);
        expect(trend.points[0]).toMatchObject({ requests: 4, tokens: 210, costMicros: 3500 });
        expect(trend.points[0]!.segments).toHaveLength(2);
    });

    it('user gets the biggest segment first so the bar reads correctly', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO usage_daily_rollups
                (day, model_name, provider_name, request_count, input_tokens, output_tokens,
                 cache_read_tokens, cache_write_tokens, total_cost_micros)
                VALUES ('2026-01-01', 'small', 'openai', 1, 10, 5, 0, 0, 100),
                       ('2026-01-01', 'large', 'openai', 1, 900, 500, 0, 0, 9000);
        `);

        const trend = await getUsageTrendFromArchive();

        expect(trend.points[0]!.segments.map((segment) => segment.name)).toEqual([
            'large',
            'small',
        ]);
    });

    it('user gets a segment with no model name labelled rather than blank', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO usage_daily_rollups
                (day, model_name, provider_name, request_count, input_tokens, output_tokens,
                 cache_read_tokens, cache_write_tokens, total_cost_micros)
                VALUES ('2026-01-01', '', '', 1, 10, 5, 0, 0, 100);
        `);

        const trend = await getUsageTrendFromArchive();

        // A blank label leaves a legend entry the user cannot identify.
        expect(trend.points[0]!.segments[0]!.name).toBeTruthy();
    });

    it('user gets an empty chart when the archive has no days yet', async () => {
        const database = openDatabase();
        routeQueriesTo(database);

        const trend = await getUsageTrendFromArchive();

        expect(trend.points).toEqual([]);
    });

    it('user gets every archived model counted with no provider or model id', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO usage_daily_rollups
                (day, model_name, provider_name, request_count, input_tokens, output_tokens,
                 cache_read_tokens, cache_write_tokens, total_cost_micros)
                VALUES ('2026-01-01', 'gpt-4o', 'openai', 1, 10, 5, 0, 0, 100);
        `);

        const trend = await getUsageTrendFromArchive();

        // The rollup keeps names, not ids, so the id is deliberately absent.
        expect(trend.points[0]!.segments[0]!.groupId).toBeNull();
    });
});

describe('user filters the usage chart', () => {
    it('user gets the archive used when no filter is applied', () => {
        // No filter means the rollup is a complete answer, so the cheap query wins.
        expect(canUseUsageArchive({ from: '2026-01-01', to: '2026-12-31' })).toBe(true);
    });

    it('user gets the archive skipped for a model filter', () => {
        expect(canUseUsageArchive({ from: '2026-01-01', to: '2026-12-31', modelIds: [1] })).toBe(
            false
        );
    });

    it('user gets the archive skipped for a provider filter', () => {
        expect(canUseUsageArchive({ from: '2026-01-01', to: '2026-12-31', providerIds: [2] })).toBe(
            false
        );
    });

    it('user gets the archive skipped for a status filter', () => {
        expect(
            canUseUsageArchive({ from: '2026-01-01', to: '2026-12-31', statuses: ['failed'] })
        ).toBe(false);
    });

    it('user gets the archive skipped when only failures are asked for', () => {
        expect(canUseUsageArchive({ from: '2026-01-01', to: '2026-12-31', onlyFailed: true })).toBe(
            false
        );
    });

    it('user gets the archive skipped when only retries are asked for', () => {
        expect(
            canUseUsageArchive({ from: '2026-01-01', to: '2026-12-31', onlyRetried: true })
        ).toBe(false);
    });

    it('user gets the archive skipped for a search term', () => {
        expect(canUseUsageArchive({ from: '2026-01-01', to: '2026-12-31', search: 'gpt' })).toBe(
            false
        );
    });

    it('user gets the archive used for a search that is only spaces', () => {
        // A blank search box is not a filter, so the rollup is still valid.
        expect(canUseUsageArchive({ from: '2026-01-01', to: '2026-12-31', search: '   ' })).toBe(
            true
        );
    });

    it('user gets the archive used for empty filter lists', () => {
        expect(
            canUseUsageArchive({
                from: '2026-01-01',
                to: '2026-12-31',
                modelIds: [],
                providerIds: [],
                statuses: [],
            })
        ).toBe(true);
    });
});
