import { createSettingsBus } from '@tests/utils/settingsTransport';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getLocale, setLocale } from '@/i18n';
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

function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('user changes the app language', () => {
    let bus: ReturnType<typeof createSettingsBus>;

    beforeEach(() => {
        vi.clearAllMocks();
        setActivePinia(createPinia());
        setLocale('zh-CN');
        mockSystemLanguage('zh-CN');
        bus = createSettingsBus();
    });

    afterEach(() => {
        setActiveSettingsService(null);
    });

    async function createStore() {
        setActiveSettingsService(new SettingsService({ transport: bus.transport('main') }));
        const { useSettingsStore } = await import('@/stores/settings');
        return useSettingsStore();
    }

    it('user loads persisted language and applies it to the i18n runtime', async () => {
        mockSettings({
            global_shortcut: 'Alt+Space',
            start_on_boot: 'false',
            start_minimized: 'true',
            output_scroll_behavior: 'follow_output',
            search_window_size_preset: 'normal',
            language: 'en-US',
        });

        const store = await createStore();

        await store.initialize();

        expect(store.settings.language).toBe('en-US');
        expect(getLocale()).toBe('en-US');
        expect(setSettingMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ key: 'language' })
        );
    }, 15000);

    it('user persists zh-CN when the language row is missing and the system language is Chinese', async () => {
        mockSettings({});
        mockSystemLanguage('zh-TW', ['zh-TW', 'en-US']);

        const store = await createStore();

        await store.initialize();

        expect(store.settings.language).toBe('zh-CN');
        expect(getLocale()).toBe('zh-CN');
        expect(setSettingMock).toHaveBeenCalledWith({ key: 'language', value: 'zh-CN' });
    });

    it('user persists en-US when the language row is missing and the system language is not Chinese', async () => {
        mockSettings({});
        mockSystemLanguage('en-GB', ['en-GB', 'fr-FR']);

        const store = await createStore();

        await store.initialize();

        expect(store.settings.language).toBe('en-US');
        expect(getLocale()).toBe('en-US');
        expect(setSettingMock).toHaveBeenCalledWith({ key: 'language', value: 'en-US' });
    });

    it('user falls back to zh-CN for invalid language values without overwriting the row', async () => {
        mockSettings({
            language: 'fr-FR',
        });

        const store = await createStore();

        await store.initialize();

        expect(store.settings.language).toBe('zh-CN');
        expect(getLocale()).toBe('zh-CN');
        expect(setSettingMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ key: 'language' })
        );
    });

    it('user updates language, persists it, applies it, and sees the change', async () => {
        mockSettings({});

        const store = await createStore();
        await store.initialize();

        await store.updateLanguage('en-US');

        expect(store.settings.language).toBe('en-US');
        expect(getLocale()).toBe('en-US');
        expect(setSettingMock).toHaveBeenLastCalledWith({ key: 'language', value: 'en-US' });
    });

    it('user does not apply language when persisting the language update fails', async () => {
        mockSettings({ language: 'zh-CN' });

        const store = await createStore();
        await store.initialize();

        setSettingMock.mockRejectedValueOnce(new Error('database unavailable'));

        await expect(store.updateLanguage('en-US')).rejects.toThrow();

        expect(store.settings.language).toBe('zh-CN');
        expect(getLocale()).toBe('zh-CN');
    });

    it('user rolls back non-language setting state when persisting the update fails', async () => {
        mockSettings({
            output_scroll_behavior: 'follow_output',
        });

        const store = await createStore();
        await store.initialize();

        setSettingMock.mockRejectedValueOnce(new Error('database unavailable'));

        await expect(store.updateOutputScrollBehavior('stay_position')).rejects.toThrow();

        expect(store.settings.outputScrollBehavior).toBe('follow_output');
    });

    it('user sees a language change made by another window converge', async () => {
        mockSettings({ language: 'zh-CN' });

        const owner = new SettingsService({ transport: bus.transport('main') });
        setActiveSettingsService(owner);
        await owner.initialize();
        const otherWindow = new SettingsService({ transport: bus.transport('win-settings') });
        await otherWindow.initialize();

        await owner.mutate('language', 'en-US');
        await flush();

        expect(otherWindow.getSnapshot().language).toBe('en-US');
    });

    it('user sees a warning and keeps the saved value when cross-window sync fails', async () => {
        mockSettings({ language: 'zh-CN' });

        const store = await createStore();
        await store.initialize();

        bus.failNotices = true;
        await store.updateLanguage('en-US');
        bus.failNotices = false;

        // The change is committed; the failed broadcast is surfaced, not swallowed.
        expect(store.settings.language).toBe('en-US');
        expect(store.lastWarning).toBeTruthy();
    });
});
