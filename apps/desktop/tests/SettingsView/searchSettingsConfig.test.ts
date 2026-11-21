import { closeTestDatabases } from '@tests/database/sqliteHarness';
import { createSettingsWindowFixture } from '@tests/utils/settingsWindow';
import { afterEach, describe, expect, it } from 'vitest';
afterEach(closeTestDatabases);

describe('user edits the search settings', () => {
    it('user normalizes defaults and invalid json', async () => {
        const {
            DEFAULT_SEARCH_SETTINGS,
            parseSearchSettingsConfig,
            serializeSearchSettingsConfig,
        } = await import('@/app/api/settings/tools');

        expect(DEFAULT_SEARCH_SETTINGS.version).toBe(1);
        expect(DEFAULT_SEARCH_SETTINGS.defaultProvider).toBe('anysearch');
        expect(DEFAULT_SEARCH_SETTINGS.maxResults).toBe(0);
        expect(DEFAULT_SEARCH_SETTINGS.fetchStrategy).toBe('prefer');
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

    it('user migrates legacy routing strategies to the new model', async () => {
        const { parseSearchSettingsConfig } = await import('@/app/api/settings/tools');

        const parallel = parseSearchSettingsConfig(
            JSON.stringify({ routingStrategy: 'parallel', parallelProviderCount: 9 })
        );
        expect(parallel.routingStrategy).toBe('priority');
        expect(parallel.parallelProviders).toBe(true);
        expect(parallel.parallelProviderCount).toBe(5);
        expect(
            parseSearchSettingsConfig(JSON.stringify({ routingStrategy: 'model' })).routingStrategy
        ).toBe('capability');
        expect(
            parseSearchSettingsConfig(JSON.stringify({ routingStrategy: 'intent' })).routingStrategy
        ).toBe('capability');
    });

    it('user trims provider keys and preserves intent routing', async () => {
        const { parseSearchSettingsConfig } = await import('@/app/api/settings/tools');

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

    it('user does not enable required-key providers without API keys', async () => {
        const { parseSearchSettingsConfig } = await import('@/app/api/settings/tools');

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

    it('user trims the DeepSeek key and keeps provider configs minimal', async () => {
        const { parseSearchSettingsConfig, serializeSearchSettingsConfig } =
            await import('@/app/api/settings/tools');

        const parsed = parseSearchSettingsConfig(
            JSON.stringify({
                defaultProvider: 'deepseek',
                providers: {
                    deepseek: { enabled: true, apiKey: '  deepseek-key  ' },
                },
            })
        );

        expect(parsed.defaultProvider).toBe('deepseek');
        expect(parsed.providers.deepseek).toEqual({
            enabled: true,
            apiKey: 'deepseek-key',
            endpoint: '',
        });
        expect(JSON.parse(serializeSearchSettingsConfig(parsed)).providers.deepseek).toEqual({
            enabled: true,
            apiKey: 'deepseek-key',
            endpoint: '',
        });
    });

    it('user does not enable the DeepSeek provider without an API key', async () => {
        const { parseSearchSettingsConfig } = await import('@/app/api/settings/tools');

        expect(
            parseSearchSettingsConfig(
                JSON.stringify({
                    defaultProvider: 'deepseek',
                    providers: { deepseek: { enabled: true, apiKey: '   ' } },
                })
            )
        ).toMatchObject({
            defaultProvider: 'auto',
            providers: { deepseek: { enabled: false, apiKey: '' } },
        });
    });

    it('user loads saved search configuration and commits edits through the main writer', async () => {
        const fixture = createSettingsWindowFixture({
            label: 'settings',
            values: {
                search_settings: JSON.stringify({ defaultProvider: 'github', maxResults: 4 }),
            },
        });
        try {
            await fixture.initialize();
            const store = fixture.tools();
            await store.initialize();
            expect(store.searchSettings).toMatchObject({
                defaultProvider: 'github',
                maxResults: 4,
            });
            await store.updateSearchSettings({
                ...store.searchSettings,
                defaultProvider: 'wikipedia',
                maxResults: 7,
            });
            expect(JSON.parse(fixture.values.get('search_settings')!)).toMatchObject({
                defaultProvider: 'wikipedia',
                maxResults: 7,
            });
        } finally {
            fixture.dispose();
        }
    });
});
