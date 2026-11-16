import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { useIsolatedGlobalShortcut } from '../../e2e-tests/test/support/desktop.js';
import { closeTestDatabases, openMigratedDatabase } from '../database/sqliteHarness';

const appRoot = path.resolve('/external/queue-e2e/session');
const testShortcut = 'Ctrl+Alt+Shift+F12';

function createNativeBoundary({ isE2e = true, dataDirectory = path.join(appRoot, 'data') } = {}) {
    const database = openMigratedDatabase();
    database
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
        .run('global_shortcut', 'Alt+Space');
    database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('language', 'zh-CN');
    const registered = new Set(['Alt+Space']);

    const native = {
        async invoke(command, payload) {
            if (command === 'get_runtime_info') return { isE2eTestMode: isE2e };
            if (command === 'get_app_directory_path') return dataDirectory;
            if (command === 'register_global_shortcut') {
                if (registered.has(payload.shortcut)) throw new Error('HotKey already registered');
                registered.add(payload.shortcut);
                return;
            }
            if (command === 'database_query') {
                const { sql, params, method } = payload.request;
                const statement = database.prepare(sql);
                if (method === 'all') return { rows: statement.all(...params) };
                return { rows: [], rowsAffected: statement.run(...params).changes };
            }
            throw new Error(`Unexpected native command: ${command}`);
        },
    };
    vi.stubGlobal('browser', {
        async execute(script, ...args) {
            return runInNewContext(`(${script.toString()})(...args)`, {
                window: { __TAURI_INTERNALS__: native },
                args,
            });
        },
    });
    return { database, registered };
}

afterEach(() => {
    closeTestDatabases();
    vi.unstubAllGlobals();
});

describe('user runs isolated desktop tests beside their installed application', () => {
    it('user given the default shortcut is occupied when preparing tests then gets a separate shortcut without changing other settings', async () => {
        const { database, registered } = createNativeBoundary();

        await useIsolatedGlobalShortcut(appRoot);

        expect(registered).toEqual(new Set(['Alt+Space', testShortcut]));
        expect(database.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual([
            { key: 'global_shortcut', value: testShortcut },
            { key: 'language', value: 'zh-CN' },
        ]);
    });

    it.each([
        { label: 'a live application', isE2e: false },
        { label: 'another data root', dataDirectory: path.resolve('/user/data') },
    ])(
        'user given $label when preparing isolated tests then keeps its settings and shortcuts untouched',
        async (options) => {
            const { database, registered } = createNativeBoundary(options);

            await expect(useIsolatedGlobalShortcut(appRoot)).rejects.toThrow('isolated E2E');

            expect(registered).toEqual(new Set(['Alt+Space']));
            expect(
                database.prepare('SELECT value FROM settings WHERE key = ?').get('global_shortcut')
            ).toEqual({ value: 'Alt+Space' });
        }
    );

    it('user given the test shortcut is also occupied when preparing tests then gets the native failure without saving an unusable shortcut', async () => {
        const { database, registered } = createNativeBoundary();
        registered.add(testShortcut);

        await expect(useIsolatedGlobalShortcut(appRoot)).rejects.toThrow(
            'HotKey already registered'
        );

        expect(
            database.prepare('SELECT value FROM settings WHERE key = ?').get('global_shortcut')
        ).toEqual({ value: 'Alt+Space' });
    });
});
