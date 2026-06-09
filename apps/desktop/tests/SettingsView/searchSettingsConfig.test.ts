import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsValues = new Map<string, string | null>();
const setSettingMock = vi.hoisted(() =>
    vi.fn(async ({ key, value }: { key: string; value: string }) => {
        settingsValues.set(key, value);
        return { id: 1, key, value, created_at: '', updated_at: '' };
    })
);
const getSettingValueMock = vi.hoisted(() =>
    vi.fn(async ({ key }: { key: string }) => settingsValues.get(key) ?? null)
);

vi.mock('@database/queries', () => ({
    getSettingValue: getSettingValueMock,
    setSetting: setSettingMock,
}));

vi.mock('@services/EventService', () => ({
    AppEvent: { SETTINGS_GENERAL_UPDATED: 'settings-general-updated' },
    eventService: {
        emit: vi.fn(async () => undefined),
        on: vi.fn(async () => undefined),
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ label: 'settings' }),
}));

describe('search settings config', () => {
    beforeEach(() => {
        settingsValues.clear();
        setSettingMock.mockClear();
        getSettingValueMock.mockClear();
        setActivePinia(createPinia());
    });

    it('normalizes defaults and invalid json', async () => {
        const {
            DEFAULT_SEARCH_SETTINGS,
            parseSearchSettingsConfig,
            serializeSearchSettingsConfig,
        } = await import('@/config/searchSettings');

        expect(DEFAULT_SEARCH_SETTINGS.version).toBe(1);
        expect(DEFAULT_SEARCH_SETTINGS.defaultProvider).toBe('anysearch');
        expect(DEFAULT_SEARCH_SETTINGS.maxResults).toBe(6);
        expect(DEFAULT_SEARCH_SETTINGS.timeoutMs).toBe(15000);
        expect(DEFAULT_SEARCH_SETTINGS.preferOfficialSources).toBe(true);
        expect(parseSearchSettingsConfig('{bad json')).toEqual(DEFAULT_SEARCH_SETTINGS);
        expect(serializeSearchSettingsConfig(parseSearchSettingsConfig(null))).toBe(
            serializeSearchSettingsConfig(DEFAULT_SEARCH_SETTINGS)
        );
        expect(parseSearchSettingsConfig('{}').version).toBe(1);
        expect(JSON.parse(serializeSearchSettingsConfig(DEFAULT_SEARCH_SETTINGS))).toMatchObject({
            version: 1,
        });
    });

    it('trims provider keys and preserves intent routing', async () => {
        const { parseSearchSettingsConfig } = await import('@/config/searchSettings');

        expect(
            parseSearchSettingsConfig(
                JSON.stringify({
                    defaultProvider: 'brave',
                    maxResults: 9,
                    timeoutMs: 30000,
                    parallelProviders: true,
                    fallbackEnabled: false,
                    preferOfficialSources: false,
                    providers: {
                        brave: { enabled: true, apiKey: '  brave-key  ' },
                        tavily: { enabled: false, apiKey: '  tavily-key  ' },
                    },
                    intentRoutes: {
                        general: 'brave',
                        academic: 'openalex',
                        technical: 'github',
                        official: 'brave',
                        news: 'tavily',
                    },
                })
            )
        ).toMatchObject({
            defaultProvider: 'brave',
            maxResults: 9,
            timeoutMs: 30000,
            parallelProviders: true,
            fallbackEnabled: false,
            preferOfficialSources: false,
            providers: {
                brave: { enabled: true, apiKey: 'brave-key' },
                tavily: { enabled: false, apiKey: 'tavily-key' },
            },
            intentRoutes: {
                general: 'brave',
                academic: 'openalex',
                technical: 'github',
                official: 'brave',
                news: 'auto',
            },
        });
    });

    it('does not enable required-key providers without API keys', async () => {
        const { parseSearchSettingsConfig } = await import('@/config/searchSettings');

        expect(
            parseSearchSettingsConfig(
                JSON.stringify({
                    defaultProvider: 'brave',
                    providers: {
                        brave: { enabled: true, apiKey: '   ' },
                        tavily: { enabled: true, apiKey: '  tavily-key  ' },
                    },
                    intentRoutes: {
                        general: 'brave',
                        official: 'tavily',
                    },
                })
            )
        ).toMatchObject({
            defaultProvider: 'auto',
            providers: {
                brave: { enabled: false, apiKey: '' },
                tavily: { enabled: true, apiKey: 'tavily-key' },
            },
            intentRoutes: {
                general: 'auto',
                official: 'tavily',
            },
        });
    });

    it('loads and saves search settings through the existing settings store', async () => {
        const { useSettingsStore } = await import('@/stores/settings');
        settingsValues.set(
            'search_settings',
            JSON.stringify({
                defaultProvider: 'github',
                maxResults: 4,
            })
        );

        const store = useSettingsStore();
        await store.initialize();

        expect(store.settings.searchSettings).toMatchObject({
            defaultProvider: 'github',
            maxResults: 4,
        });

        await store.updateSearchSettings({
            ...store.settings.searchSettings,
            defaultProvider: 'wikipedia',
            maxResults: 7,
        });

        expect(setSettingMock).toHaveBeenLastCalledWith({
            key: 'search_settings',
            value: expect.stringContaining('"defaultProvider":"wikipedia"'),
        });
    });
});
