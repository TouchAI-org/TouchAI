import { createSettingsBus } from '@tests/utils/settingsTransport';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setActiveSettingsService } from '@/services/SettingsService';
import { SettingsService } from '@/services/SettingsService/service';

const { getSettingValueMock, setSettingMock } = vi.hoisted(() => ({
    getSettingValueMock: vi.fn(),
    setSettingMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    getSettingValue: getSettingValueMock,
    setSetting: setSettingMock,
}));

vi.mock('@services/NativeService', () => ({
    native: {
        autostart: {
            isAutostartEnabled: vi.fn(async () => false),
            enableAutostart: vi.fn(async () => undefined),
            disableAutostart: vi.fn(async () => undefined),
        },
        shortcut: {
            registerGlobalShortcut: vi.fn(async () => undefined),
        },
        window: {
            setSearchWindowDefaults: vi.fn(async () => undefined),
        },
    },
}));

function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('user recovers settings after the first load fails', () => {
    let bus: ReturnType<typeof createSettingsBus>;

    beforeEach(() => {
        vi.clearAllMocks();
        setActivePinia(createPinia());
        bus = createSettingsBus();
        const values: Record<string, string | null> = { output_scroll_behavior: 'stay_position' };
        getSettingValueMock.mockImplementation(
            async ({ key }: { key: string }) => values[key] ?? null
        );
        setSettingMock.mockImplementation(
            async ({ key, value }: { key: string; value: string }) => ({
                id: 1,
                key,
                value,
                created_at: '2026-06-03 00:00:00',
                updated_at: '2026-06-03 00:00:00',
            })
        );
    });

    afterEach(() => {
        setActiveSettingsService(null);
    });

    it('user sees the settings mirror converge when the owner appears after a failed first load', async () => {
        // No owner yet: the client window's handshake fails.
        setActiveSettingsService(
            new SettingsService({
                transport: bus.transport('win-settings'),
                requestTimeoutMs: 20,
            })
        );
        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();

        await expect(store.initialize()).rejects.toBeTruthy();
        expect(store.initialized).toBe(false);

        // The owner comes up later and announces readiness; the already-subscribed store
        // must mirror the authoritative snapshot without being initialized again.
        const owner = new SettingsService({ transport: bus.transport('main') });
        setActiveSettingsService(owner);
        await owner.initialize();
        await flush();

        expect(store.settings.outputScrollBehavior).toBe('stay_position');
        expect(store.initialized).toBe(false);

        // An explicit retry now succeeds and flips the gate.
        setActiveSettingsService(
            new SettingsService({
                transport: bus.transport('win-settings'),
                requestTimeoutMs: 50,
            })
        );
        await store.initialize();
        expect(store.initialized).toBe(true);
    });
});
