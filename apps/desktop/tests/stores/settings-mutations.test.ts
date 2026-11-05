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

describe('user changes a setting while a refresh is in flight', () => {
    let bus: ReturnType<typeof createSettingsBus>;
    let releaseWrite: () => void;
    let mutationStarted: Promise<void>;

    beforeEach(() => {
        vi.clearAllMocks();
        setActivePinia(createPinia());
        bus = createSettingsBus();

        const values: Record<string, string | null> = {
            start_minimized: 'true',
        };
        getSettingValueMock.mockImplementation(
            async ({ key }: { key: string }) => values[key] ?? null
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

        const client = new SettingsService({ transport: bus.transport('win-settings') });
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
        bus.focus('win-settings');
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
});
