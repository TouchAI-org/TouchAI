import { closeTestDatabases } from '@tests/database/sqliteHarness';
import { createSettingsWindowFixture } from '@tests/utils/settingsWindow';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

let fixture: ReturnType<typeof createSettingsWindowFixture> | undefined;
afterEach(() => {
    fixture?.dispose();
    fixture = undefined;
    closeTestDatabases();
    vi.useRealTimers();
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

import { emitTo } from '@tauri-apps/api/event';
import { getTauriInvokeCalls, type TauriInvokeCall } from '@tests/utils/tauri';
import { createPinia, disposePinia } from 'pinia';
import { createApp } from 'vue';

import { settingsApiKey } from '@/app/api/settings/preferences';
import { SETTINGS_TRANSPORT_EVENT } from '@/modules/settings';
import { useSettingsStore } from '@/stores/settings';

function registration(call: TauriInvokeCall) {
    return (
        call.cmd === 'plugin:event|listen' &&
        (call.payload as { event?: string })?.event === SETTINGS_TRANSPORT_EVENT
    );
}
function unregistration(call: TauriInvokeCall) {
    return (
        call.cmd === 'plugin:event|unlisten' &&
        (call.payload as { event?: string })?.event === SETTINGS_TRANSPORT_EVENT
    );
}

describe('given bootstrap owns the preferences listener and stores are projections', () => {
    it('user initializes concurrently and receives one live subscription and committed updates', async () => {
        fixture = createSettingsWindowFixture({ values: { language: 'zh-CN' } });
        const store = fixture.store();
        await Promise.all([store.initialize(), store.initialize()]);
        await fixture.owner.api.mutate('language', 'en-US');
        expect(store.initialized).toBe(true);
        expect(store.settings.language).toBe('en-US');
        expect(getTauriInvokeCalls().filter(registration)).toHaveLength(1);
        await store.dispose();
        expect(getTauriInvokeCalls().filter(unregistration)).toHaveLength(0);
        expect((await fixture.owner.api.mutate('language', 'zh-CN')).status).toBe('committed');
    });

    it('user closes the window during loading and no late projection becomes ready', async () => {
        const entered = deferred();
        const read = deferred();
        fixture = createSettingsWindowFixture({
            query: {
                async beforeQuery({ sql }) {
                    if (sql.startsWith('select')) {
                        entered.resolve();
                        await read.promise;
                    }
                },
            },
        });
        const store = fixture.store();
        const loading = store.initialize();
        await entered.promise;
        await store.dispose();
        fixture.owner.dispose();
        read.resolve();
        await loading;
        expect(store.initialized).toBe(false);
        expect(store.loading).toBe(false);
        expect(store.settings.language).toBe('zh-CN');
        expect(getTauriInvokeCalls().filter(unregistration)).toHaveLength(1);
    });

    it('user closes the window during native registration and its eventual listener is released', async () => {
        const entered = deferred();
        const registered = deferred();
        fixture = createSettingsWindowFixture({
            query: {
                async aroundInvoke(call, next) {
                    if (registration(call)) {
                        entered.resolve();
                        await registered.promise;
                    }
                    return next();
                },
            },
        });
        const store = fixture.store();
        const loading = store.initialize();
        await entered.promise;
        await store.dispose();
        fixture.owner.dispose();
        registered.resolve();
        await loading;
        await flushPromises();
        expect(store.initialized).toBe(false);
        expect(store.settings.language).toBe('zh-CN');
        expect(getTauriInvokeCalls().filter(unregistration)).toHaveLength(1);
    });

    it('user closes after native registration and ignores queued events while its handle is pending', async () => {
        const entered = deferred();
        const registered = deferred();
        fixture = createSettingsWindowFixture({
            query: {
                async aroundInvoke(call, next) {
                    const result = await next();
                    if (registration(call)) {
                        entered.resolve();
                        await registered.promise;
                    }
                    return result;
                },
            },
        });
        const store = fixture.store();
        const loading = store.initialize();
        await entered.promise;
        await store.dispose();
        fixture.owner.dispose();
        await emitTo('main', SETTINGS_TRANSPORT_EVENT, {
            kind: 'notice',
            hostEpoch: 'stale',
            revision: 1,
            type: 'change',
            changedKeys: ['language'],
        });
        expect(store.settings.language).toBe('zh-CN');
        registered.resolve();
        await loading;
        await flushPromises();
        expect(store.initialized).toBe(false);
        expect(getTauriInvokeCalls().filter(unregistration)).toHaveLength(1);
    });

    it('user opens a fresh projection while registration is pending without creating another writer', async () => {
        const entered = deferred();
        const registered = deferred();
        fixture = createSettingsWindowFixture({
            values: { language: 'zh-CN' },
            query: {
                async aroundInvoke(call, next) {
                    if (registration(call)) {
                        entered.resolve();
                        await registered.promise;
                    }
                    return next();
                },
            },
        });
        const previous = fixture.store();
        const first = previous.initialize();
        await entered.promise;
        await previous.dispose();
        disposePinia(fixture.pinia);
        const pinia = createPinia();
        const app = createApp({ render: () => null });
        app.use(pinia);
        app.provide(settingsApiKey, fixture.owner.api);
        const current = app.runWithContext(() => useSettingsStore(pinia));
        try {
            const second = current.initialize();
            await flushPromises();
            expect(current.initialized).toBe(false);
            registered.resolve();
            await Promise.all([first, second]);
            await fixture.owner.api.mutate('language', 'en-US');
            expect(current.initialized).toBe(true);
            expect(current.settings.language).toBe('en-US');
            expect(previous.initialized).toBe(false);
            expect(previous.settings.language).toBe('zh-CN');
            expect(getTauriInvokeCalls().filter(registration)).toHaveLength(1);
        } finally {
            registered.resolve();
            disposePinia(pinia);
        }
    });

    it('user retries failed native registration and receives updates after successful startup', async () => {
        let reject = true;
        fixture = createSettingsWindowFixture({
            values: { language: 'zh-CN' },
            query: {
                aroundInvoke(call, next) {
                    if (registration(call) && reject) throw new Error('registration failed');
                    return next();
                },
            },
        });
        const store = fixture.store();
        await expect(store.initialize()).rejects.toThrow('registration failed');
        expect(store.initialized).toBe(false);
        reject = false;
        await store.initialize();
        await fixture.owner.api.mutate('language', 'en-US');
        expect(store.initialized).toBe(true);
        expect(store.settings.language).toBe('en-US');
    });

    it('user disposes Pinia and subsequent committed updates cannot mutate the detached projection', async () => {
        fixture = createSettingsWindowFixture({ values: { language: 'zh-CN' } });
        const store = fixture.store();
        await store.initialize();
        store.$dispose();
        await fixture.owner.api.mutate('language', 'en-US');
        expect(store.initialized).toBe(false);
        expect(store.settings.language).toBe('zh-CN');
        expect(fixture.values.get('language')).toBe('en-US');
    });

    it('user closes with delayed native unregistration and queued events cannot revive the projection', async () => {
        const removed = deferred();
        let delay = false;
        fixture = createSettingsWindowFixture({
            values: { language: 'zh-CN' },
            query: {
                async aroundInvoke(call, next) {
                    if (delay && unregistration(call)) await removed.promise;
                    return next();
                },
            },
        });
        const store = fixture.store();
        await store.initialize();
        delay = true;
        await store.dispose();
        fixture.owner.dispose();
        await emitTo('main', SETTINGS_TRANSPORT_EVENT, {
            kind: 'notice',
            hostEpoch: 'late',
            revision: 1,
            type: 'change',
            changedKeys: ['language'],
        });
        expect(store.initialized).toBe(false);
        expect(store.settings.language).toBe('zh-CN');
        removed.resolve();
        await flushPromises();
    });

    it('user refreshes concurrently and loading remains visible until both reads finish', async () => {
        const firstRead = deferred();
        const secondRead = deferred();
        let block = false;
        let reads = 0;
        fixture = createSettingsWindowFixture({
            query: {
                async beforeQuery({ sql }) {
                    if (block && sql.startsWith('select') && sql.includes('"settings"')) {
                        reads++;
                        await (reads === 1 ? firstRead.promise : secondRead.promise);
                    }
                },
            },
        });
        const store = fixture.store();
        await store.initialize();
        block = true;
        const first = store.refresh();
        const second = store.refresh();
        firstRead.resolve();
        await first;
        expect(store.loading).toBe(true);
        secondRead.resolve();
        await second;
        expect(store.loading).toBe(false);
    });
});
