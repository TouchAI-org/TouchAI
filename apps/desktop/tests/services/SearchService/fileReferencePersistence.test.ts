import type { QuickShortcutItem } from '@services/NativeService';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    loadFileReferenceSuggestions,
    recordAcceptedFileReference,
} from '@/services/SearchService/fileReferenceHistory';

import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '../../database/sqliteHarness';

afterEach(closeTestDatabases);

function reference(path: string): QuickShortcutItem {
    return { name: path.split(/[\\/]/).pop()!, path, source: 'file' };
}

describe('given accepted file references survive reopening the picker', () => {
    it('user references two files and reuses the first then sees durable recency order without duplicate entries', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        let timestamp = '2026-11-10 10:00:00.100';
        database.function('strftime', { varargs: true }, () => timestamp);
        const native = {
            getFileReferenceSuggestions: async (paths: string[]) => paths.map(reference),
        };
        const reopen = () => loadFileReferenceSuggestions(native, 12, new AbortController().signal);

        recordAcceptedFileReference('D:/Docs/Plan.md');
        await vi.waitFor(async () => {
            expect((await reopen()).map((file) => file.name)).toEqual(['Plan.md']);
        });

        timestamp = '2026-11-10 10:00:00.200';
        recordAcceptedFileReference('D:/Docs/Notes.md');
        await vi.waitFor(async () => {
            expect((await reopen()).map((file) => file.name)).toEqual(['Notes.md', 'Plan.md']);
        });

        timestamp = '2026-11-10 10:00:00.300';
        recordAcceptedFileReference('D:\\Docs\\Plan.md');
        await vi.waitFor(async () => {
            expect((await reopen()).map((file) => file.name)).toEqual(['Plan.md', 'Notes.md']);
        });
        expect(
            database
                .prepare(
                    'SELECT path_norm, click_count FROM quick_search_click_stats WHERE query_norm = ? ORDER BY updated_at DESC'
                )
                .all('@reference')
        ).toEqual([
            { path_norm: 'D:\\Docs\\Plan.md', click_count: 2 },
            { path_norm: 'D:\\Docs\\Notes.md', click_count: 1 },
        ]);
    });

    it('user opens document suggestions repeatedly without accepting one then leaves reference history empty', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        const document = reference('D:/Docs/Recent.md');
        const native = { getFileReferenceSuggestions: async () => [document] };

        for (let attempt = 0; attempt < 2; attempt += 1) {
            await expect(
                loadFileReferenceSuggestions(native, 12, new AbortController().signal)
            ).resolves.toEqual([document]);
        }

        expect(
            database
                .prepare('SELECT path_norm FROM quick_search_click_stats WHERE query_norm = ?')
                .all('@reference')
        ).toEqual([]);
    });

    it('user accepts a reference while history is read-only then keeps document suggestions available without storing a partial entry', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec('PRAGMA query_only = ON');
        const document = reference('D:/Docs/Recent.md');

        expect(() => recordAcceptedFileReference(document.path)).not.toThrow();
        await flushPromises();
        await expect(
            loadFileReferenceSuggestions(
                { getFileReferenceSuggestions: async () => [document] },
                12,
                new AbortController().signal
            )
        ).resolves.toEqual([document]);
        expect(
            database
                .prepare('SELECT path_norm FROM quick_search_click_stats WHERE query_norm = ?')
                .all('@reference')
        ).toEqual([]);
    });
});
