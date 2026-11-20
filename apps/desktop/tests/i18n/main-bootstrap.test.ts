import { mockWindows } from '@tauri-apps/api/mocks';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { network } from '@tests/utils/agentWindow';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type App, defineComponent, h } from 'vue';
import { useRoute } from 'vue-router';

import { initializeApp } from '@/app/bootstrap';
import { resetObservabilityForTests } from '@/platform/diagnostics';
import router from '@/router';
import { useSettingsStore } from '@/stores/settings';

vi.mock('@tauri-apps/plugin-opener', () => ({
    openUrl: vi.fn(),
    openPath: vi.fn(),
    revealItemInDir: vi.fn(),
}));

// A small route keeps this test on the real root/bootstrap without loading unrelated screens.
const screen = defineComponent({
    setup() {
        const route = useRoute();
        const preferences = useSettingsStore();
        return () =>
            h(
                'div',
                { 'data-testid': 'startup-screen' },
                `route:${route.path};speed:${preferences.animationSpeed}`
            );
    },
});
router.addRoute({ path: '/bootstrap-fixture', component: screen });
router.addRoute({ path: '/bootstrap-next', component: screen });

let database: ReturnType<typeof openMigratedDatabase>;
let release: (() => void) | undefined;
const realOpen = window.open;
const observeListeners = (target: EventTarget) => vi.spyOn(target, 'addEventListener');
let windowListeners: ReturnType<typeof observeListeners>;
let documentListeners: ReturnType<typeof observeListeners>;
let lastApp: App | undefined;
const root = () => document.querySelector<HTMLElement>('[data-testid="startup-screen"]');

beforeEach(async () => {
    database = openMigratedDatabase();
    routeQueriesTo(database);
    database.exec(`INSERT INTO settings (key,value) VALUES ('animation_speed','faster'),('language','en-US'),('app_update_auto_check','false');
        INSERT INTO llm_metadata (model_id,name,modalities) VALUES ('cached','Cached model','{}');
        INSERT INTO llm_metadata_aliases (alias,model_id) VALUES ('cached','cached');`);
    mockWindows('main');
    mockTauriCommand('get_runtime_info', { isE2eTestMode: false });
    mockTauriCommand('get_app_directory_path', '/fixture/fonts');
    mockTauriCommand('mcp_get_all_client_statuses', []);
    mockTauriCommand('computer_use_list_tools', []);
    mockTauriCommand('agent_skills_discover_system_files', []);
    mockTauriCommand('agent_skills_discover_user_files', []);
    network.respondToDiscovery = async () => new Response(null, { status: 304 });
    vi.mocked(openUrl).mockReset().mockResolvedValue(undefined);
    document.body.innerHTML = '<div id="app"></div>';
    await router.replace('/bootstrap-fixture');
    windowListeners = observeListeners(window);
    documentListeners = observeListeners(document);
});
afterEach(async () => {
    release?.();
    release = undefined;
    window.dispatchEvent(new Event('pagehide'));
    await flushPromises();
    lastApp = (document.getElementById('app') as HTMLElement & { __vue_app__?: App })?.__vue_app__;
    lastApp?.unmount();
    resetObservabilityForTests();
    for (const [event, handler, options] of windowListeners?.mock.calls ?? [])
        if (handler) window.removeEventListener(event, handler, options);
    for (const [event, handler, options] of documentListeners?.mock.calls ?? [])
        if (handler) document.removeEventListener(event, handler, options);
    windowListeners?.mockRestore();
    documentListeners?.mockRestore();
    window.open = realOpen;
    document.body.innerHTML = '';
    closeTestDatabases();
});
async function start() {
    await initializeApp();
    await expect.poll(() => root()?.textContent).toContain('route:/bootstrap-fixture');
    return root()!;
}
function click(href: string, nested = false) {
    const anchor = document.createElement('a');
    anchor.href = href;
    const target = nested ? anchor.appendChild(document.createElement('span')) : anchor;
    document.body.append(anchor);
    return target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('given the actual application bootstrap owns main startup', () => {
    it('user opens main and sees real routing and committed preferences on its first frame', async () => {
        expect((await start()).textContent).toBe('route:/bootstrap-fixture;speed:faster');
    });
    it('user waits for saved preferences before seeing a default-valued first frame', async () => {
        let waiting = false;
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        routeQueriesTo(database, {
            beforeQuery({ sql }) {
                if (sql.startsWith('select') && sql.includes('from "settings"')) {
                    waiting = true;
                    return barrier;
                }
            },
        });
        const startup = initializeApp();
        await expect.poll(() => waiting).toBe(true);
        expect(root()).toBeNull();
        release!();
        await startup;
        expect(root()?.textContent).toContain('speed:faster');
    });
    it('user sees a usable frame while tool registration is still waiting on storage', async () => {
        let waiting = false;
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        routeQueriesTo(database, {
            beforeQuery({ sql }) {
                if (sql.includes('built_in_tools')) {
                    waiting = true;
                    return barrier;
                }
            },
        });
        await start();
        await expect.poll(() => waiting).toBe(true);
        expect(root()).not.toBeNull();
        release!();
    });
    it('user retains a usable frame when saved preferences cannot be read', async () => {
        routeQueriesTo(database, {
            beforeQuery({ sql }) {
                if (sql.startsWith('select') && sql.includes('from "settings"'))
                    throw new Error('fixture settings unavailable');
            },
        });
        await expect(initializeApp()).resolves.toBeUndefined();
        expect(root()).not.toBeNull();
    });
    it('user retains a usable frame when optional tool registration fails', async () => {
        routeQueriesTo(database, {
            beforeQuery({ sql }) {
                if (sql.includes('built_in_tools'))
                    throw new Error('fixture tool storage unavailable');
            },
        });
        await start();
        expect(root()).not.toBeNull();
    });
    it('user opens main and the product font is requested through the native files boundary', async () => {
        await start();
        await expect
            .poll(() => getTauriInvokeCalls('get_app_directory_path'))
            .toContainEqual(expect.objectContaining({ payload: { directory: 'ASSETS_FONT' } }));
    });
    it('user closes main and no later online event starts detached update work', async () => {
        await start();
        window.dispatchEvent(new Event('pagehide'));
        await flushPromises();
        const calls = getTauriInvokeCalls('updater_check_for_updates').length;
        window.dispatchEvent(new Event('online'));
        await flushPromises();
        expect(getTauriInvokeCalls('updater_check_for_updates')).toHaveLength(calls);
    });
});

describe('given auxiliary windows use the same bootstrap as bounded clients', () => {
    it('user opens Tray and sees its frame before a main preference owner is available', async () => {
        mockWindows('tray-menu');
        await start();
        expect(root()).not.toBeNull();
        expect(getTauriInvokeCalls('database_query')).toEqual([]);
        expect(getTauriInvokeCalls('get_app_directory_path')).toEqual([]);
        expect(network.discovery).toEqual([]);
    });
    it.each(['computer-use-glow', 'tray-menu'])(
        'user opens %s without creating tool or update authority',
        async (label) => {
            mockWindows(label);
            await start();
            expect(getTauriInvokeCalls('computer_use_list_tools')).toEqual([]);
            expect(getTauriInvokeCalls('updater_check_for_updates')).toEqual([]);
            expect(network.discovery).toEqual([]);
            if (label === 'computer-use-glow')
                await expect
                    .poll(() => getTauriInvokeCalls('get_app_directory_path').length)
                    .toBeGreaterThan(0);
        }
    );
});

describe('given links are handled by the actual application bootstrap', () => {
    it('user clicks an app-relative link and navigates inside the real router', async () => {
        await start();
        expect(click('/bootstrap-next')).toBe(false);
        await expect.poll(() => root()?.textContent).toContain('route:/bootstrap-next');
        expect(openUrl).not.toHaveBeenCalled();
    });
    it('user clicks a nested external link and opens it in the system browser', async () => {
        await start();
        expect(click('https://example.com/docs', true)).toBe(false);
        expect(openUrl).toHaveBeenCalledWith('https://example.com/docs');
    });
    it('user clicks ordinary content without opening a browser or changing routes', async () => {
        await start();
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(root()?.textContent).toContain('route:/bootstrap-fixture');
        expect(openUrl).not.toHaveBeenCalled();
    });
    it('user opens links from application code and keeps local links in the current browser', async () => {
        const browserOpen = vi.fn(() => ({ name: 'window' }) as Window);
        window.open = browserOpen as typeof window.open;
        await start();
        for (const href of [
            '/bootstrap-next',
            'tauri://localhost/settings',
            'asset://localhost/icon.png',
        ])
            expect(window.open(href)).toEqual({ name: 'window' });
        expect(browserOpen).toHaveBeenCalledTimes(3);
        expect(window.open('https://example.com/docs')).toBeNull();
        expect(openUrl).toHaveBeenCalledWith('https://example.com/docs');
    });
    it('user opens a malformed external link without crashing the application', async () => {
        await start();
        expect(window.open('http://[bad')).toBeNull();
        expect(openUrl).toHaveBeenCalledWith('http://[bad');
    });
});

describe('given main starts optional model metadata after paint', () => {
    it('user receives bundled metadata when the existing cache is empty', async () => {
        database.exec('DELETE FROM llm_metadata_aliases; DELETE FROM llm_metadata');
        await start();
        await expect
            .poll(
                () => Number(database.prepare('SELECT count(*) AS n FROM llm_metadata').get()!.n),
                { timeout: 15000 }
            )
            .toBeGreaterThan(0);
    }, 20000);
    it('user retains cached metadata and aliases without replaying the bundled seed', async () => {
        await start();
        await expect.poll(() => network.discovery.length).toBe(1);
        expect(database.prepare('SELECT model_id FROM llm_metadata').all()).toEqual([
            { model_id: 'cached' },
        ]);
    });
    it('user receives bundled aliases when the cached model list has no aliases', async () => {
        database.exec('DELETE FROM llm_metadata_aliases');
        await start();
        await expect
            .poll(
                () =>
                    Number(
                        database.prepare('SELECT count(*) AS n FROM llm_metadata_aliases').get()!.n
                    ),
                { timeout: 15000 }
            )
            .toBeGreaterThan(0);
    }, 20000);
    it('user keeps a usable frame when bundled metadata storage refuses the seed', async () => {
        database.exec('DELETE FROM llm_metadata_aliases; DELETE FROM llm_metadata');
        routeQueriesTo(database, {
            beforeQuery({ sql }) {
                if (sql.startsWith('insert into "llm_metadata"'))
                    throw new Error('fixture metadata storage unavailable');
            },
        });
        await start();
        await expect.poll(() => network.discovery.length).toBe(1);
        expect(root()).not.toBeNull();
        expect(database.prepare('SELECT count(*) AS n FROM llm_metadata').get()).toEqual({ n: 0 });
    });
    it('user keeps a usable frame while an optional remote catalog check fails after paint', async () => {
        let paintedAtRequest = false;
        network.respondToDiscovery = async () => {
            paintedAtRequest = root() !== null;
            throw new Error('fixture catalog unavailable');
        };
        await start();
        await expect.poll(() => network.discovery.length).toBe(1);
        expect(paintedAtRequest).toBe(true);
        expect(root()).not.toBeNull();
    });
});
