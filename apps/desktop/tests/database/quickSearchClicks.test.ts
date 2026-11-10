import {
    findQuickSearchClicksByQuery,
    findRecentQuickSearchClicksByQuery,
    upsertQuickSearchClick,
} from '@database/queries/quickSearchClicks';
import { afterEach, describe, expect, it } from 'vitest';

import { closeTestDatabases, openMigratedDatabase, routeQueriesTo } from './sqliteHarness';

afterEach(() => {
    closeTestDatabases();
});

describe('given accepted file references are stored in existing quick-search history', () => {
    it('user gets reference paths ordered by latest use rather than total click count', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO quick_search_click_stats
                (query_norm, path_norm, click_count, updated_at)
            VALUES
                ('@reference', 'D:\\Docs\\Often.md', 100, '2026-11-08 10:00:00'),
                ('@reference', 'D:\\Docs\\Latest.pdf', 1, '2026-11-09 10:00:00'),
                ('another query', 'D:\\Docs\\Unrelated.txt', 500, '2026-11-09 11:00:00');
        `);

        const rows = await findRecentQuickSearchClicksByQuery({
            queryNorm: '@reference',
            limit: 12,
        });

        expect(rows.map((row) => row.path_norm)).toEqual([
            'D:\\Docs\\Latest.pdf',
            'D:\\Docs\\Often.md',
        ]);
    });

    it('user gets a reused path counted once and moved to the latest timestamp', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO quick_search_click_stats
                (query_norm, path_norm, click_count, updated_at)
            VALUES
                ('@reference', 'D:\\Docs\\Plan.md', 4, '2020-01-01 10:00:00'),
                ('@reference', 'D:\\Docs\\Newer.txt', 1, '2020-01-02 10:00:00');
        `);

        await upsertQuickSearchClick({
            queryNorm: '@reference',
            pathNorm: 'D:\\Docs\\Plan.md',
            maxClickCount: 1_000_000,
        });

        const rows = await findRecentQuickSearchClicksByQuery({
            queryNorm: '@reference',
            limit: 12,
        });
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            path_norm: 'D:\\Docs\\Plan.md',
            click_count: 5,
        });
    });

    it('user keeps the existing frequency ordering for ordinary typed searches', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO quick_search_click_stats
                (query_norm, path_norm, click_count, updated_at)
            VALUES
                ('touch ai', 'D:\\Tools\\Old.lnk', 10, '2026-11-08 10:00:00'),
                ('touch ai', 'D:\\Tools\\New.lnk', 2, '2026-11-09 10:00:00');
        `);

        const rows = await findQuickSearchClicksByQuery({
            queryNorm: 'touch ai',
            limit: 12,
        });

        expect(rows.map((row) => row.path_norm)).toEqual([
            'D:\\Tools\\Old.lnk',
            'D:\\Tools\\New.lnk',
        ]);
    });

    it('user given a reused file when first referencing another file later in the same second then sees the new reference first', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        database.function('datetime', { varargs: true }, () => '2026-11-09 10:00:00');
        database.function('strftime', { varargs: true }, () => '2026-11-09 10:00:00.200');
        database.exec(`
            INSERT INTO quick_search_click_stats
                (query_norm, path_norm, click_count, updated_at)
            VALUES ('@reference', 'D:\\Docs\\Earlier.md', 10, '2026-11-09 10:00:00.100');
        `);

        await upsertQuickSearchClick({
            queryNorm: '@reference',
            pathNorm: 'D:\\Docs\\Latest.md',
            maxClickCount: 1_000_000,
        });

        const rows = await findRecentQuickSearchClicksByQuery({
            queryNorm: '@reference',
            limit: 12,
        });
        expect(rows.map((row) => row.path_norm)).toEqual([
            'D:\\Docs\\Latest.md',
            'D:\\Docs\\Earlier.md',
        ]);
    });
});
