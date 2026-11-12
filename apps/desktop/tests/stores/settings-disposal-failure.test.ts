import { setActiveSettingsService, type SettingsService } from '@services/SettingsService';
import { createDefaultGeneralSettings } from '@services/SettingsService/domain';
import { flushPromises } from '@vue/test-utils';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '@/stores/settings';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
});

afterEach(async () => {
    setActiveSettingsService(null);
    disposePinia(pinia);
    await flushPromises();
});

describe('user disposes while settings initialization fails', () => {
    it('user sees no late initialization error escape after disposal', async () => {
        const readStarted = deferred();
        const failRead = deferred();
        const service = {
            dispose: vi.fn(),
            getSnapshot: () => createDefaultGeneralSettings(),
            initialize: vi.fn(async () => {
                readStarted.resolve();
                await failRead.promise;
                throw new Error('storage read failed');
            }),
            mutate: vi.fn(),
            refresh: vi.fn(),
            subscribe: vi.fn(() => () => undefined),
        } as unknown as SettingsService;
        setActiveSettingsService(service);
        const store = useSettingsStore();
        const initialization = store.initialize();
        await readStarted.promise;

        await store.dispose();
        failRead.resolve();

        await expect(initialization).resolves.toBeUndefined();
        expect(store.initialized).toBe(false);
        expect(store.loading).toBe(false);
        expect(store.settings.language).toBe('zh-CN');
        expect(service.dispose).toHaveBeenCalledTimes(1);
    });

    it('user replaces the active service and disposing the old store leaves the replacement open', async () => {
        const createService = () =>
            ({
                dispose: vi.fn(),
                getSnapshot: () => createDefaultGeneralSettings(),
                initialize: vi.fn(async () => undefined),
                mutate: vi.fn(),
                refresh: vi.fn(),
                subscribe: vi.fn(() => () => undefined),
            }) as unknown as SettingsService;
        const firstService = createService();
        const replacementService = createService();
        setActiveSettingsService(firstService);
        const store = useSettingsStore();
        await store.initialize();

        setActiveSettingsService(replacementService);
        await store.dispose();

        expect(firstService.dispose).toHaveBeenCalledTimes(1);
        expect(replacementService.dispose).not.toHaveBeenCalled();
    });
});
