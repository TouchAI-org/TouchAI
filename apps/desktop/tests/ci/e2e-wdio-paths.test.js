import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { createSettingsWindowFixture } from '@tests/utils/settingsWindow';
import { mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

import { useIsolatedGlobalShortcut } from '../../e2e-tests/test/support/desktop.js';
import {
    resolveE2eAppBinaryPath,
    resolveE2eCargoProfile,
    resolveE2eRuntimeDirectory,
    resolveTauriBuildArgs,
} from '../../e2e-tests/wdio.paths.js';
import { closeTestDatabases } from '../database/sqliteHarness';

const appRoot = path.resolve('/external/queue-e2e/session');
const testShortcut = 'Ctrl+Alt+Shift+F12';

const settingsFixtures = [];
async function createNativeBoundary({
    isE2e = true,
    dataDirectory = path.join(appRoot, 'data'),
} = {}) {
    const fixture = createSettingsWindowFixture({
        values: { global_shortcut: 'Alt+Space', language: 'zh-CN' },
    });
    settingsFixtures.push(fixture);
    await fixture.initialize();
    const store = fixture.store();
    await store.initialize();
    const registered = new Set(['Alt+Space']);
    mockTauriCommand('register_global_shortcut', ({ shortcut }) => {
        if (registered.has(shortcut)) throw new Error('HotKey already registered');
        registered.clear();
        registered.add(shortcut);
    });
    const native = {
        async invoke(command) {
            if (command === 'get_runtime_info') return { isE2eTestMode: isE2e };
            if (command === 'get_app_directory_path') return dataDirectory;
            throw new Error(`Unexpected native command: ${command}`);
        },
    };
    vi.stubGlobal('browser', {
        async execute(script, ...args) {
            return runInNewContext(`(${script.toString()})(...args)`, {
                window: {
                    __TAURI_INTERNALS__: native,
                    __TOUCHAI_E2E__: {
                        setGlobalShortcut: (shortcut) => store.updateGlobalShortcut(shortcut),
                    },
                },
                args,
            });
        },
    });
    return {
        database: fixture.database,
        registered,
        store,
        owner: fixture.owner.api,
        initialSettings: fixture.database
            .prepare('SELECT key, value FROM settings ORDER BY key')
            .all(),
    };
}

afterEach(() => {
    for (const fixture of settingsFixtures.splice(0)) fixture.dispose();
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
        const { database, registered, store, owner, initialSettings } =
            await createNativeBoundary();

        await useIsolatedGlobalShortcut(appRoot);

        expect(store.globalShortcut).toBe(testShortcut);
        expect(owner.getSnapshot().globalShortcut).toBe(testShortcut);

        expect(registered).toEqual(new Set([testShortcut]));
        expect(database.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual(
            initialSettings.map((row) =>
                row.key === 'global_shortcut' ? { ...row, value: testShortcut } : row
            )
        );
    });

    it.each([
        { label: 'a live application', isE2e: false },
        { label: 'another data root', dataDirectory: path.resolve('/user/data') },
    ])(
        'user given $label when preparing isolated tests then keeps its settings and shortcuts untouched',
        async (options) => {
            const { database, registered } = await createNativeBoundary(options);

            await expect(useIsolatedGlobalShortcut(appRoot)).rejects.toThrow('isolated E2E');

            expect(registered).toEqual(new Set(['Alt+Space']));
            expect(
                database.prepare('SELECT value FROM settings WHERE key = ?').get('global_shortcut')
            ).toEqual({ value: 'Alt+Space' });
        }
    );

    it('user given the test shortcut is also occupied when preparing tests then gets the native failure without saving an unusable shortcut', async () => {
        const { database, registered } = await createNativeBoundary();
        registered.add(testShortcut);

        await expect(useIsolatedGlobalShortcut(appRoot)).rejects.toThrow();

        expect(
            database.prepare('SELECT value FROM settings WHERE key = ?').get('global_shortcut')
        ).toEqual({ value: 'Alt+Space' });
    });
});
