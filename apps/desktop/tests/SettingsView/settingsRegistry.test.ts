import { describe, expect, it } from 'vitest';

import {
    BROWSER_SETTINGS_KEY,
    BROWSER_SETTINGS_VERSION,
    DEFAULT_BROWSER_SETTINGS,
    DEFAULT_SEARCH_SETTINGS,
    getDefaultHomepageError,
    parseBrowserSettingsConfig,
    parseSearchSettingsConfig,
    SEARCH_SETTINGS_KEY,
    SEARCH_SETTINGS_VERSION,
    serializeBrowserSettingsConfig,
    serializeSearchSettingsConfig,
} from '@/app/api/settings/tools';
import { getSettingsNavigationItem } from '@/views/SettingsView/settingsNavigation';

describe('given browser and search retain their own public configuration contracts', () => {
    it('user reopens existing configuration with unchanged persistent keys and versions', () => {
        expect(BROWSER_SETTINGS_KEY).toBe('browser_settings');
        expect(SEARCH_SETTINGS_KEY).toBe('search_settings');
        expect(JSON.parse(serializeBrowserSettingsConfig(DEFAULT_BROWSER_SETTINGS)).version).toBe(
            BROWSER_SETTINGS_VERSION
        );
        expect(JSON.parse(serializeSearchSettingsConfig(DEFAULT_SEARCH_SETTINGS)).version).toBe(
            SEARCH_SETTINGS_VERSION
        );
    });

    it('user finds browser and search in navigation without putting UI metadata in persisted configuration', () => {
        expect(getSettingsNavigationItem('browser')).toMatchObject({
            id: 'browser',
            icon: 'globe',
        });
        expect(getSettingsNavigationItem('search')).toMatchObject({ id: 'search', icon: 'search' });
        expect(
            JSON.parse(serializeBrowserSettingsConfig(DEFAULT_BROWSER_SETTINGS))
        ).not.toHaveProperty('ui');
        expect(
            JSON.parse(serializeSearchSettingsConfig(DEFAULT_SEARCH_SETTINGS))
        ).not.toHaveProperty('store');
    });

    it('user receives independent defaults for absent or malformed saved values', () => {
        const browser = parseBrowserSettingsConfig(null);
        const search = parseSearchSettingsConfig('{bad json');
        expect(browser).toMatchObject({ defaultHomepage: 'https://touch-ai.org' });
        expect(search).toMatchObject({ defaultProvider: 'anysearch' });
        browser.permissions.navigate = 'deny';
        search.providers.anysearch.enabled = false;
        expect(parseBrowserSettingsConfig('{bad json').permissions.navigate).toBe('ask');
        expect(parseSearchSettingsConfig(null).providers.anysearch.enabled).toBe(true);
    });

    it('user saves an out-of-range result limit and the owning serializer keeps it within the existing ceiling', () => {
        const config = parseSearchSettingsConfig(null);
        config.maxResults = 99;
        expect(JSON.parse(serializeSearchSettingsConfig(config))).toMatchObject({ maxResults: 10 });
    });

    it('user receives the existing validation reason before a non-HTTP homepage can be submitted', () => {
        expect(
            getDefaultHomepageError({
                ...DEFAULT_BROWSER_SETTINGS,
                defaultHomepage: 'ftp://touch-ai.org',
            })
        ).toBe('settings.browser.validation.invalidHomepage');
        expect(
            getDefaultHomepageError({
                ...DEFAULT_BROWSER_SETTINGS,
                defaultHomepage: 'https://touch-ai.org',
            })
        ).toBeNull();
    });

    it('user cannot retain an enabled required-key provider or routes to it without the credential', () => {
        const config = parseSearchSettingsConfig(null);
        config.providers.brave = { ...config.providers.brave, enabled: true, apiKey: '' };
        config.defaultProvider = 'brave';
        config.intentRoutes.general = 'brave';
        expect(parseSearchSettingsConfig(serializeSearchSettingsConfig(config))).toMatchObject({
            defaultProvider: 'auto',
            intentRoutes: { general: 'auto' },
            providers: { brave: { enabled: false } },
        });
    });
});
