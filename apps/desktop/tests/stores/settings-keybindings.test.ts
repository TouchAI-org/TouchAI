import { createSettingsBus } from '@tests/utils/settingsTransport';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultSearchKeybindings } from '@/config/searchKeybindings';
import { log } from '@/services/ObservabilityService';
import { setActiveSettingsService } from '@/services/SettingsService';
import { SettingsService } from '@/services/SettingsService/service';

const { getSettingValueMock, getSettingValuesMock, setSettingMock } = vi.hoisted(() => ({
    getSettingValueMock: vi.fn(),
    getSettingValuesMock: vi.fn(),
    setSettingMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    getSettingValue: getSettingValueMock,
    getSettingValues: getSettingValuesMock,
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

function mockSettings(values: Record<string, string | null>) {
    getSettingValueMock.mockImplementation(async ({ key }: { key: string }) => values[key] ?? null);
    getSettingValuesMock.mockImplementation(async ({ keys }: { keys: string[] }) =>
        Object.fromEntries(keys.map((key) => [key, values[key] ?? null]))
    );
    setSettingMock.mockImplementation(async ({ key, value }: { key: string; value: string }) => ({
        id: 1,
        key,
        value,
        created_at: '2026-06-03 00:00:00',
        updated_at: '2026-06-03 00:00:00',
    }));
}

describe('user changes the search shortcuts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setActivePinia(createPinia());
    });

    afterEach(() => {
        setActiveSettingsService(null);
    });

    async function createStore() {
        const bus = createSettingsBus();
        setActiveSettingsService(new SettingsService({ transport: bus.transport('main') }));
        const { useSettingsStore } = await import('@/stores/settings');
        return useSettingsStore();
    }

    it('user persists default search keybindings when the row is missing', async () => {
        mockSettings({});

        const store = await createStore();

        await store.initialize();

        expect(store.settings.searchKeybindings).toEqual(createDefaultSearchKeybindings());
        expect(store.settings.searchKeybindings['search.window.maximize']).toBe('F11');
        expect(store.settings.searchKeybindings['search.settings.open']).toBe('Mod+,');
        expect(setSettingMock).toHaveBeenCalledWith({
            key: 'search_keybindings',
            value: JSON.stringify(createDefaultSearchKeybindings()),
        });
    });

    it('user keeps initialization usable when default keybinding persistence fails', async () => {
        mockSettings({});
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
        setSettingMock.mockImplementation(
            async ({ key, value }: { key: string; value: string }) => {
                if (key === 'search_keybindings') {
                    throw new Error('database locked');
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

        const store = await createStore();

        await expect(store.initialize()).resolves.toBeUndefined();

        expect(store.initialized).toBe(true);
        expect(store.settings.searchKeybindings).toEqual(createDefaultSearchKeybindings());
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('search_keybindings'));
    });

    it('user loads persisted search keybindings and merges missing defaults', async () => {
        mockSettings({
            search_keybindings: JSON.stringify({
                'search.history.open': 'Mod+Y',
                'search.request.cancel': null,
                'search.draft.clearAll': 'Mod+Backspace',
            }),
        });

        const store = await createStore();

        await store.initialize();

        expect(store.settings.searchKeybindings['search.history.open']).toBe('Mod+Y');
        expect(store.settings.searchKeybindings).toEqual({
            ...createDefaultSearchKeybindings(),
            'search.history.open': 'Mod+Y',
        });
        expect(store.settings.searchKeybindings['search.window.maximize']).toBe(
            createDefaultSearchKeybindings()['search.window.maximize']
        );
        expect(setSettingMock).toHaveBeenCalledWith({
            key: 'search_keybindings',
            value: JSON.stringify({
                ...createDefaultSearchKeybindings(),
                'search.history.open': 'Mod+Y',
            }),
        });
        expect(store.settings.searchKeybindings['search.input.focus']).toBe(
            createDefaultSearchKeybindings()['search.input.focus']
        );
    });

    it('user updates search keybindings, persists them, and sees the change applied', async () => {
        mockSettings({});

        const store = await createStore();
        await store.initialize();

        const nextKeybindings = {
            ...createDefaultSearchKeybindings(),
            'search.input.focus': 'Mod+K',
        };

        await store.updateSearchKeybindings(nextKeybindings);

        expect(store.settings.searchKeybindings).toEqual(nextKeybindings);
        expect(setSettingMock).toHaveBeenLastCalledWith({
            key: 'search_keybindings',
            value: JSON.stringify(nextKeybindings),
        });
    });
});
