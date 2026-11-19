import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

import { createBuiltinRegistrations, createFileSearchTools, createTools } from '@/modules/tools';

afterEach(closeTestDatabases);

async function fixture() {
    routeQueriesTo(openMigratedDatabase());
    const catalog = createBuiltinRegistrations(
        createFileSearchTools({ messages: { t: (key) => key, tt: (text) => text } })
    );
    await catalog.synchronize();
    return createTools({ registrations: catalog.registrations, formatError: (code) => code });
}

describe('given file search retains the shipped Everything protocol', () => {
    it('user receives matching file references after a structured local search', async () => {
        const tools = await fixture();
        mockTauriCommand('quick_search_search_files', [
            { name: 'fixture.ts', path: 'C:\\fixture\\fixture.ts' },
        ]);
        try {
            const outcome = await (
                await tools.snapshot()
            ).execute(
                {
                    id: 'search',
                    name: 'builtin__file_search',
                    arguments:
                        '{"query":"fixture","limit":3,"includeShortcutFiles":false,"extensionList":"ts","caseSensitive":true}',
                },
                { iteration: 0 }
            );
            expect(outcome).toMatchObject({ isError: false, status: 'success' });
            expect(outcome.result).toContain('C:\\fixture\\fixture.ts');
            expect(
                getTauriInvokeCalls('quick_search_search_files').map((call) => call.payload)
            ).toEqual([{ query: 'fixture case: ext:ts', limit: 3, include_shortcuts: false }]);
        } finally {
            tools.dispose();
        }
    });

    it('user receives the existing failure text when the local search backend is unavailable', async () => {
        const tools = await fixture();
        mockTauriCommand('quick_search_search_files', () => {
            throw new Error('fixture backend unavailable');
        });
        mockTauriCommand('quick_search_get_status', { last_error: 'Fixture indexing unavailable' });
        try {
            const outcome = await (
                await tools.snapshot()
            ).execute(
                {
                    id: 'search',
                    name: 'builtin__file_search',
                    arguments: '{"query":"fixture","limit":3,"includeShortcutFiles":false}',
                },
                { iteration: 0 }
            );
            expect(outcome).toMatchObject({ isError: true, status: 'error' });
            expect(outcome.result).toContain('Fixture indexing unavailable');
        } finally {
            tools.dispose();
        }
    });
});
