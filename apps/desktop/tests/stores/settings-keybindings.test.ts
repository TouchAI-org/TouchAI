import { AppEvent } from '@services/EventService';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultSearchKeybindings } from '@/config/searchKeybindings';

const { eventHandlers, eventServiceMock, getSettingValueMock, setSettingMock, windowMock } =
    vi.hoisted(() => ({
        eventHandlers: new Map<string, (payload: unknown) => void>(),
        eventServiceMock: {
            emit: vi.fn(),
            on: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
                eventHandlers.set(event, handler);
                return () => {
                    eventHandlers.delete(event);
                };
            }),
        },
        getSettingValueMock: vi.fn(),
        setSettingMock: vi.fn(),
        windowMock: {
            label: 'settings',
        },
    }));

vi.mock('@database/queries', () => ({
    getSettingValue: getSettingValueMock,
    setSetting: setSettingMock,
}));

vi.mock('@services/EventService', async () => {
    const actual =
        await vi.importActual<typeof import('@services/EventService')>('@services/EventService');
    return {
        ...actual,
        eventService: eventServiceMock,
    };
});

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => windowMock,
}));

function mockSettings(values: Record<string, string | null>) {
    getSettingValueMock.mockImplementation(async ({ key }: { key: string }) => values[key] ?? null);
    setSettingMock.mockImplementation(async ({ key, value }: { key: string; value: string }) => ({
        id: 1,
        key,
        value,
        created_at: '2026-06-03 00:00:00',
        updated_at: '2026-06-03 00:00:00',
    }));
}

describe('settings search keybindings state', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
        setActivePinia(createPinia());
        windowMock.label = 'settings';
    });

    it('persists default search keybindings when the row is missing', async () => {
        mockSettings({});

        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();

        await store.initialize();

        expect(store.settings.searchKeybindings).toEqual(createDefaultSearchKeybindings());
        expect(store.settings.searchKeybindings['search.window.maximize']).toBe('F11');
        expect(setSettingMock).toHaveBeenCalledWith({
            key: 'search_keybindings',
            value: JSON.stringify(createDefaultSearchKeybindings()),
        });
        expect(store.settings.lastClosedSessionId).toBeNull();
    });

    it('loads and updates the persisted last closed session id', async () => {
        mockSettings({
            last_closed_session_id: '42',
        });

        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();

        await store.initialize();

        expect(store.settings.lastClosedSessionId).toBe(42);

        await store.updateLastClosedSessionId(108);

        expect(store.settings.lastClosedSessionId).toBe(108);
        expect(setSettingMock).toHaveBeenLastCalledWith({
            key: 'last_closed_session_id',
            value: '108',
        });
    });

    it('loads persisted search keybindings and merges missing defaults', async () => {
        mockSettings({
            search_keybindings: JSON.stringify({
                'search.history.open': 'Mod+Y',
                'search.request.cancel': null,
                'search.draft.clearAll': 'Mod+Backspace',
            }),
        });

        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();

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

    it('updates search keybindings, persists them, and broadcasts the change', async () => {
        mockSettings({});

        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();
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
        expect(eventServiceMock.emit).toHaveBeenLastCalledWith(AppEvent.SETTINGS_GENERAL_UPDATED, {
            sourceId: expect.any(String),
            windowLabel: 'settings',
            key: 'search_keybindings',
            value: nextKeybindings,
        });
    });
});
