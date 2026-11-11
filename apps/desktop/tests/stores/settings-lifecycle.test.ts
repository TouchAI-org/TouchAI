import { AppEvent, eventService } from '@services/EventService';
import type { DatabaseQueryRequest } from '@services/NativeService/database';
import { flushPromises } from '@vue/test-utils';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useSettingsStore } from '@/stores/settings';

import {
    getTauriInvokeCalls,
    interceptTauriInvoke,
    mockTauriCommand,
    type TauriInvokeCall,
} from '../utils/tauri';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

function isSettingsRegistration(call: TauriInvokeCall): boolean {
    return (
        call.cmd === 'plugin:event|listen' &&
        (call.payload as { event?: string })?.event === AppEvent.SETTINGS_GENERAL_UPDATED
    );
}

async function broadcastLanguage() {
    await eventService.emit(AppEvent.SETTINGS_GENERAL_UPDATED, {
        sourceId: 'another-window',
        windowLabel: 'settings',
        key: 'language',
        value: 'en-US',
    });
}

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    const values = new Map<string, string>([['language', 'zh-CN']]);
    mockTauriCommand('database_query', (payload: unknown) => {
        const { request } = payload as { request: DatabaseQueryRequest };
        const writing = request.sql.startsWith('insert');
        if (writing) {
            values.set(String(request.params?.[0]), String(request.params?.[1]));
        }
        const entries = writing
            ? [[String(request.params?.[0]), String(request.params?.[1])] as const]
            : [...values];
        return {
            rows: entries.map(([key, value]) => ({
                id: 1,
                key,
                value,
                created_at: '2026-11-10 00:00:00',
                updated_at: '2026-11-10 00:00:00',
            })),
            rowsAffected: writing ? 1 : 0,
            lastInsertId: writing ? 1 : null,
        };
    });
});

afterEach(async () => {
    disposePinia(pinia);
    await flushPromises();
});

describe('user shares and disposes settings initialization', () => {
    it('user initializes twice concurrently and receives one live settings subscription', async () => {
        const store = useSettingsStore();

        await Promise.all([store.initialize(), store.initialize()]);
        await broadcastLanguage();

        expect(store.initialized).toBe(true);
        expect(store.settings.language).toBe('en-US');
        expect(getTauriInvokeCalls().filter(isSettingsRegistration)).toHaveLength(1);
        await store.dispose();
    });

    it('user disposes during storage loading and no late subscription becomes ready', async () => {
        const readStarted = deferred();
        const read = deferred();
        interceptTauriInvoke(async (call, next) => {
            if (call.cmd === 'database_query') {
                readStarted.resolve();
                await read.promise;
            }
            return next();
        });
        const store = useSettingsStore();
        const initialization = store.initialize();
        await readStarted.promise;

        await store.dispose();
        read.resolve();
        await initialization;
        await broadcastLanguage();

        expect(store.initialized).toBe(false);
        expect(store.settings.language).not.toBe('en-US');
        expect(getTauriInvokeCalls().filter(isSettingsRegistration)).toEqual([]);
    });

    it('user disposes during native registration and its eventual listener is released', async () => {
        const registrationStarted = deferred();
        const registration = deferred();
        interceptTauriInvoke(async (call, next) => {
            if (isSettingsRegistration(call)) {
                registrationStarted.resolve();
                await registration.promise;
            }
            return next();
        });
        const store = useSettingsStore();
        const initialization = store.initialize();
        await registrationStarted.promise;

        await store.dispose();
        registration.resolve();
        await initialization;
        await flushPromises();
        await broadcastLanguage();

        expect(store.initialized).toBe(false);
        expect(store.settings.language).toBe('zh-CN');
        expect(getTauriInvokeCalls('plugin:event|unlisten')).toEqual([
            expect.objectContaining({
                payload: expect.objectContaining({ event: AppEvent.SETTINGS_GENERAL_UPDATED }),
            }),
        ]);
    });

    it('user ignores already registered settings events after disposal while their native handle is pending', async () => {
        const registrationStarted = deferred();
        const registration = deferred();
        interceptTauriInvoke(async (call, next) => {
            if (isSettingsRegistration(call)) {
                const result = await next();
                registrationStarted.resolve();
                await registration.promise;
                return result;
            }
            return next();
        });
        const store = useSettingsStore();
        const initialization = store.initialize();
        await registrationStarted.promise;

        try {
            await store.dispose();
            await broadcastLanguage();
            expect(store.initialized).toBe(false);
            expect(store.settings.language).toBe('zh-CN');
        } finally {
            registration.resolve();
            await initialization;
            await flushPromises();
        }

        await broadcastLanguage();
        expect(store.settings.language).toBe('zh-CN');
        expect(getTauriInvokeCalls('plugin:event|unlisten')).toEqual([
            expect.objectContaining({
                payload: expect.objectContaining({ event: AppEvent.SETTINGS_GENERAL_UPDATED }),
            }),
        ]);
    });

    it('user reinitializes after disposal without waiting for the previous registration', async () => {
        const registrationStarted = deferred();
        const registration = deferred();
        let deferRegistration = true;
        interceptTauriInvoke(async (call, next) => {
            if (isSettingsRegistration(call) && deferRegistration) {
                deferRegistration = false;
                registrationStarted.resolve();
                await registration.promise;
            }
            return next();
        });
        const store = useSettingsStore();
        const previous = store.initialize();
        await registrationStarted.promise;
        await store.dispose();

        const current = store.initialize();
        await flushPromises();
        const readyBeforePreviousCompletion = store.initialized;
        registration.resolve();
        await Promise.all([previous, current]);
        await broadcastLanguage();

        expect(readyBeforePreviousCompletion).toBe(true);
        expect(store.initialized).toBe(true);
        expect(store.settings.language).toBe('en-US');
        await store.dispose();
    });

    it('user retries after failed registration and receives updates from the new initialization', async () => {
        let rejectRegistration = true;
        interceptTauriInvoke((call, next) => {
            if (isSettingsRegistration(call) && rejectRegistration) {
                throw new Error('registration failed');
            }
            return next();
        });
        const store = useSettingsStore();

        await expect(store.initialize()).rejects.toThrow('registration failed');
        expect(store.initialized).toBe(false);
        rejectRegistration = false;
        await store.initialize();
        await broadcastLanguage();

        expect(store.initialized).toBe(true);
        expect(store.settings.language).toBe('en-US');
        await store.dispose();
    });

    it('user disposes the Pinia owner and subsequent settings events cannot mutate its store', async () => {
        const store = useSettingsStore();
        await store.initialize();

        store.$dispose();
        await flushPromises();
        await broadcastLanguage();

        expect(store.initialized).toBe(false);
        expect(store.settings.language).toBe('zh-CN');
    });

    it('user disposes while native unregistration is delayed and queued settings events are ignored', async () => {
        const store = useSettingsStore();
        await store.initialize();
        const unregistration = deferred();
        interceptTauriInvoke(async (call, next) => {
            if (call.cmd === 'plugin:event|unlisten') await unregistration.promise;
            return next();
        });

        await store.dispose();
        await broadcastLanguage();
        unregistration.resolve();
        await flushPromises();

        expect(store.initialized).toBe(false);
        expect(store.settings.language).toBe('zh-CN');
    });

    it('user refreshes concurrently and loading remains visible until both reads finish', async () => {
        const store = useSettingsStore();
        await store.initialize();
        const firstRead = deferred();
        const secondRead = deferred();
        let reads = 0;
        interceptTauriInvoke(async (call, next) => {
            if (call.cmd === 'database_query') {
                reads += 1;
                await (reads === 1 ? firstRead.promise : secondRead.promise);
            }
            return next();
        });

        const first = store.refresh();
        const second = store.refresh();
        firstRead.resolve();
        await first;
        const loadingWithPendingRead = store.loading;
        secondRead.resolve();
        await second;

        expect(loadingWithPendingRead).toBe(true);
        expect(store.loading).toBe(false);
        await store.dispose();
    });
});
