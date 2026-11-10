import { createSettingsBus } from '@tests/utils/settingsTransport';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, watch } from 'vue';

import { setActiveSettingsService } from '@/services/SettingsService';
import { SettingsService } from '@/services/SettingsService/service';

const { getSettingValueMock, getSettingValuesMock, setSettingMock, nativeMock } = vi.hoisted(
    () => ({
        getSettingValueMock: vi.fn(),
        getSettingValuesMock: vi.fn(),
        setSettingMock: vi.fn(),
        nativeMock: {
            isAutostartEnabled: vi.fn(async () => false),
            enableAutostart: vi.fn(async () => undefined),
            disableAutostart: vi.fn(async () => undefined),
            registerGlobalShortcut: vi.fn(async () => undefined),
            setSearchWindowDefaults: vi.fn(async () => undefined),
        },
    })
);

vi.mock('@database/queries', () => ({
    getSettingValue: getSettingValueMock,
    getSettingValues: getSettingValuesMock,
    setSetting: setSettingMock,
}));

vi.mock('@services/NativeService', () => ({
    native: {
        autostart: {
            isAutostartEnabled: nativeMock.isAutostartEnabled,
            enableAutostart: nativeMock.enableAutostart,
            disableAutostart: nativeMock.disableAutostart,
        },
        shortcut: {
            registerGlobalShortcut: nativeMock.registerGlobalShortcut,
        },
        window: {
            setSearchWindowDefaults: nativeMock.setSearchWindowDefaults,
        },
    },
}));

function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('user changes a setting while a refresh is in flight', () => {
    let bus: ReturnType<typeof createSettingsBus>;
    let releaseWrite: () => void;
    let mutationStarted: Promise<void>;

    beforeEach(() => {
        vi.clearAllMocks();
        nativeMock.isAutostartEnabled.mockResolvedValue(false);
        setActivePinia(createPinia());
        bus = createSettingsBus();

        const values: Record<string, string | null> = {
            start_on_boot: 'true',
            start_minimized: 'true',
        };
        getSettingValueMock.mockImplementation(
            async ({ key }: { key: string }) => values[key] ?? null
        );
        getSettingValuesMock.mockImplementation(async ({ keys }: { keys: string[] }) =>
            Object.fromEntries(keys.map((key) => [key, values[key] ?? null]))
        );

        let markMutationStarted: () => void = () => undefined;
        mutationStarted = new Promise((resolve) => {
            markMutationStarted = resolve;
        });
        const writeGate = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });
        setSettingMock.mockImplementation(
            async ({ key, value }: { key: string; value: string }) => {
                if (key === 'start_minimized') {
                    markMutationStarted();
                    await writeGate;
                }
                return {
                    id: 1,
                    key,
                    value,
                    created_at: '2026-06-03 00:00:00',
                    updated_at: '2026-06-03 00:00:00',
                };
            }
        );
    });

    afterEach(() => {
        setActiveSettingsService(null);
    });

    it('user keeps the requested value while a focus refresh still sees the old snapshot', async () => {
        const owner = new SettingsService({ transport: bus.transport('main') });
        setActiveSettingsService(owner);
        await owner.initialize();

        const client = new SettingsService({ transport: bus.transport('settings') });
        setActiveSettingsService(client);
        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();
        await store.initialize();

        expect(store.settings.startMinimized).toBe(true);

        store.settings.startMinimized = false;
        const update = store.updateStartMinimized(false);
        await mutationStarted;

        const refreshRepliesBefore = bus.sent.filter(
            (entry) =>
                entry.from === 'main' &&
                entry.message.kind === 'reply' &&
                entry.message.snapshot?.revision === 1
        ).length;
        bus.focus('settings');
        await vi.waitFor(() => {
            const refreshReplies = bus.sent.filter(
                (entry) =>
                    entry.from === 'main' &&
                    entry.message.kind === 'reply' &&
                    entry.message.snapshot?.revision === 1
            ).length;
            expect(refreshReplies).toBeGreaterThan(refreshRepliesBefore);
        });
        await flush();

        expect(store.settings.startMinimized).toBe(false);

        releaseWrite();
        await update;
        expect(store.settings.startMinimized).toBe(false);
    });

    it('user keeps an unrelated draft section when another setting changes', async () => {
        const owner = new SettingsService({ transport: bus.transport('main') });
        setActiveSettingsService(owner);
        await owner.initialize();
        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();
        await store.initialize();

        const searchSettings = store.settings.searchSettings;
        const resets: unknown[] = [];
        const stop = watch(
            () => store.settings.searchSettings,
            (config) => resets.push(config),
            { deep: true }
        );

        const update = store.updateStartMinimized(false);
        releaseWrite();
        await update;
        await nextTick();

        expect(store.settings.searchSettings).toBe(searchSettings);
        expect(resets).toHaveLength(0);
        stop();
    });

    it('user sees the effective OS autostart state when reopening settings', async () => {
        const owner = new SettingsService({ transport: bus.transport('main') });
        setActiveSettingsService(owner);
        await owner.initialize();
        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();
        await store.initialize();
        expect(store.settings.startOnBoot).toBe(true);

        nativeMock.isAutostartEnabled.mockResolvedValue(false);
        await store.refreshStartOnBoot();

        expect(store.settings.startOnBoot).toBe(false);
        expect(nativeMock.disableAutostart).toHaveBeenCalledTimes(1);
        expect(setSettingMock).toHaveBeenCalledWith({ key: 'start_on_boot', value: 'false' });
    });

    it('user keeps an autostart toggle made while the OS state is loading', async () => {
        const owner = new SettingsService({ transport: bus.transport('main') });
        setActiveSettingsService(owner);
        await owner.initialize();
        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();
        await store.initialize();
        expect(store.settings.startOnBoot).toBe(true);

        vi.clearAllMocks();
        let resolveEffectiveState: (enabled: boolean) => void = () => undefined;
        nativeMock.isAutostartEnabled.mockImplementationOnce(
            () =>
                new Promise<boolean>((resolve) => {
                    resolveEffectiveState = resolve;
                })
        );

        const refresh = store.refreshStartOnBoot();
        await vi.waitFor(() => {
            expect(nativeMock.isAutostartEnabled).toHaveBeenCalledTimes(1);
        });
        await store.updateStartOnBoot(false);

        resolveEffectiveState(true);
        await refresh;

        expect(store.settings.startOnBoot).toBe(false);
        expect(nativeMock.disableAutostart).toHaveBeenCalledTimes(1);
        expect(nativeMock.enableAutostart).not.toHaveBeenCalled();
    });
});
