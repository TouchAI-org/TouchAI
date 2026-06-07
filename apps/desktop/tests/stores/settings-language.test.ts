import { AppEvent } from '@services/EventService';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getLocale, setLocale } from '@/i18n';

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

function mockSystemLanguage(language: string, languages: string[] = [language]) {
    Object.defineProperty(window.navigator, 'language', {
        configurable: true,
        value: language,
    });
    Object.defineProperty(window.navigator, 'languages', {
        configurable: true,
        value: languages,
    });
}

function mockSettings(values: Record<string, string | null>) {
    getSettingValueMock.mockImplementation(async ({ key }: { key: string }) => values[key] ?? null);
    setSettingMock.mockImplementation(async ({ key, value }: { key: string; value: string }) => ({
        id: 1,
        key,
        value,
        created_at: '2026-05-20 00:00:00',
        updated_at: '2026-05-20 00:00:00',
    }));
}

describe('settings language state', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
        setActivePinia(createPinia());
        setLocale('zh-CN');
        windowMock.label = 'settings';
        mockSystemLanguage('zh-CN');
    });

    it('loads persisted language and applies it to the i18n runtime', async () => {
        mockSettings({
            global_shortcut: 'Alt+Space',
            start_on_boot: 'false',
            start_minimized: 'true',
            output_scroll_behavior: 'follow_output',
            search_window_size_preset: 'normal',
            language: 'en-US',
        });

        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();

        await store.initialize();

        expect(store.settings.language).toBe('en-US');
        expect(getLocale()).toBe('en-US');
        expect(setSettingMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ key: 'language' })
        );
    }, 15000);

    it('persists zh-CN when the language row is missing and the system language is Chinese', async () => {
        mockSettings({});
        mockSystemLanguage('zh-TW', ['zh-TW', 'en-US']);

        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();

        await store.initialize();

        expect(store.settings.language).toBe('zh-CN');
        expect(getLocale()).toBe('zh-CN');
        expect(setSettingMock).toHaveBeenCalledWith({ key: 'language', value: 'zh-CN' });
    });

    it('persists en-US when the language row is missing and the system language is not Chinese', async () => {
        mockSettings({});
        mockSystemLanguage('en-GB', ['en-GB', 'fr-FR']);

        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();

        await store.initialize();

        expect(store.settings.language).toBe('en-US');
        expect(getLocale()).toBe('en-US');
        expect(setSettingMock).toHaveBeenCalledWith({ key: 'language', value: 'en-US' });
    });

    it('falls back to zh-CN for invalid language values without overwriting the row', async () => {
        mockSettings({
            language: 'fr-FR',
        });

        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();

        await store.initialize();

        expect(store.settings.language).toBe('zh-CN');
        expect(getLocale()).toBe('zh-CN');
        expect(setSettingMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ key: 'language' })
        );
    });

    it('updates language, persists it, applies it, and broadcasts the change', async () => {
        mockSettings({});

        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();
        await store.initialize();

        await store.updateLanguage('en-US');

        expect(store.settings.language).toBe('en-US');
        expect(getLocale()).toBe('en-US');
        expect(setSettingMock).toHaveBeenLastCalledWith({ key: 'language', value: 'en-US' });
        expect(eventServiceMock.emit).toHaveBeenLastCalledWith(AppEvent.SETTINGS_GENERAL_UPDATED, {
            sourceId: expect.any(String),
            windowLabel: 'settings',
            key: 'language',
            value: 'en-US',
        });
    });

    it('does not apply language when persisting the language update fails', async () => {
        mockSettings({ language: 'zh-CN' });

        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();
        await store.initialize();

        const failure = new Error('database unavailable');
        setSettingMock.mockRejectedValueOnce(failure);

        await expect(store.updateLanguage('en-US')).rejects.toThrow('database unavailable');

        expect(store.settings.language).toBe('zh-CN');
        expect(getLocale()).toBe('zh-CN');
        expect(eventServiceMock.emit).not.toHaveBeenCalled();
    });

    it('rolls back non-language setting state when persisting the update fails', async () => {
        mockSettings({
            output_scroll_behavior: 'follow_output',
        });

        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();
        await store.initialize();

        const failure = new Error('database unavailable');
        setSettingMock.mockRejectedValueOnce(failure);

        await expect(store.updateOutputScrollBehavior('stay_position')).rejects.toThrow(
            'database unavailable'
        );

        expect(store.settings.outputScrollBehavior).toBe('follow_output');
        expect(eventServiceMock.emit).not.toHaveBeenCalled();
    });

    it('applies language changes from another window without rebroadcasting', async () => {
        mockSettings({
            language: 'zh-CN',
        });

        const { useSettingsStore } = await import('@/stores/settings');
        const store = useSettingsStore();
        await store.initialize();

        eventHandlers.get(AppEvent.SETTINGS_GENERAL_UPDATED)?.({
            sourceId: 'other-window',
            windowLabel: 'main',
            key: 'language',
            value: 'en-US',
        });

        expect(store.settings.language).toBe('en-US');
        expect(getLocale()).toBe('en-US');
        expect(eventServiceMock.emit).not.toHaveBeenCalled();
    });
});
