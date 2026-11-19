import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

import { useIsolatedGlobalShortcut } from '../../e2e-tests/test/support/desktop.js';
import {
    resolveE2eAppBinaryPath,
    resolveE2eCargoProfile,
    resolveE2eRuntimeDirectory,
    resolveTauriBuildArgs,
} from '../../e2e-tests/wdio.paths.js';
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

describe('user starts desktop tests with a built application', () => {
    it('user gets the debug application when starting tests without a custom build profile', () => {
        const env = {};

        expect(resolveE2eCargoProfile(env)).toBeUndefined();
        expect(resolveTauriBuildArgs(env)).toEqual(['tauri', 'build', '--debug', '--no-bundle']);
        expect(resolveE2eAppBinaryPath('D:\\target\\e2e', 'win32', env)).toBe(
            path.resolve('D:\\target\\e2e', 'debug', APP_PRODUCT_CONFIG.packaging.mainExe)
        );
    });

    it('user gets the matching application when choosing a custom build profile', () => {
        const env = {
            TOUCHAI_E2E_CARGO_PROFILE: 'ci-check',
        };

        expect(resolveE2eCargoProfile(env)).toBe('ci-check');
        expect(resolveTauriBuildArgs(env)).toEqual([
            'tauri',
            'build',
            '--debug',
            '--no-bundle',
            '--',
            '--profile',
            'ci-check',
        ]);
        expect(resolveE2eAppBinaryPath('D:\\target\\e2e', 'win32', env)).toBe(
            path.resolve('D:\\target\\e2e', 'ci-check', APP_PRODUCT_CONFIG.packaging.mainExe)
        );
    });
});

describe('user runs desktop regressions with isolated data', () => {
    it('user given no runtime override when starting tests then uses the dedicated workspace runtime', () => {
        expect(resolveE2eRuntimeDirectory('/checkout', {})).toBe(
            path.resolve('/checkout', '.e2e-runtime')
        );
    });

    it('user given an external runtime directory when starting tests then keeps output outside the checkout', () => {
        const directory = path.resolve('/external/queue-e2e');

        expect(
            resolveE2eRuntimeDirectory('/checkout', { TOUCHAI_E2E_RUNTIME_ROOT: directory })
        ).toBe(directory);
    });

    it('user given a relative runtime override when starting tests then resolves it from the checkout', () => {
        expect(
            resolveE2eRuntimeDirectory('/checkout', { TOUCHAI_E2E_RUNTIME_ROOT: '../queue-e2e' })
        ).toBe(path.resolve('/checkout', '../queue-e2e'));
    });

    it.each(['/', '/checkout'])(
        'user given an unsafe runtime root %s when starting tests then cannot clear that directory',
        (directory) => {
            expect(() =>
                resolveE2eRuntimeDirectory('/checkout', { TOUCHAI_E2E_RUNTIME_ROOT: directory })
            ).toThrow('dedicated directory');
        }
    );

    it.each(['..', '../..', '/work'])(
        'user given a checkout ancestor %s when starting tests then cannot clear the checkout or sibling directories',
        (directory) => {
            expect(() =>
                resolveE2eRuntimeDirectory('/work/project', {
                    TOUCHAI_E2E_RUNTIME_ROOT: directory,
                })
            ).toThrow('dedicated directory');
        }
    );
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
