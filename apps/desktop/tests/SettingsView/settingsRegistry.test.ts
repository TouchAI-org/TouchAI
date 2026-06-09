import { describe, expect, it } from 'vitest';

import type { SearchSettingsConfig } from '@/config/searchSettings';
import {
    cloneJsonSettingsDefault,
    findJsonSettingsSection,
    JSON_SETTINGS_SECTIONS,
    parseJsonSettingsValue,
    serializeJsonSettingsValue,
    validateJsonSettingsValue,
} from '@/config/settingsRegistry';

describe('settings registry', () => {
    it('registers json-backed settings sections by persistent key', () => {
        expect(JSON_SETTINGS_SECTIONS.map((section) => section.key)).toEqual([
            'browser_settings',
            'search_settings',
        ]);
        expect(findJsonSettingsSection('browser_settings')?.stateKey).toBe('browserSettings');
        expect(findJsonSettingsSection('search_settings')?.stateKey).toBe('searchSettings');
        expect(findJsonSettingsSection('browser_settings')).toMatchObject({
            version: 1,
            store: {
                computedName: 'browserSettings',
                updaterName: 'updateBrowserSettings',
            },
        });
        expect(findJsonSettingsSection('search_settings')).toMatchObject({
            version: 1,
            store: {
                computedName: 'searchSettings',
                updaterName: 'updateSearchSettings',
            },
        });
        expect(findJsonSettingsSection('browser_settings')?.ui).toMatchObject({
            sectionId: 'browser',
            icon: 'globe',
        });
        expect(findJsonSettingsSection('search_settings')?.ui).toMatchObject({
            sectionId: 'search',
            icon: 'search',
        });
        expect(findJsonSettingsSection('language')).toBeNull();
    });

    it('clones defaults and parses invalid persisted values through section definitions', () => {
        const browserSection = findJsonSettingsSection('browser_settings');
        const searchSection = findJsonSettingsSection('search_settings');

        expect(browserSection).not.toBeNull();
        expect(searchSection).not.toBeNull();
        if (!browserSection || !searchSection) {
            throw new Error('expected json settings sections to be registered');
        }

        const browserDefault = cloneJsonSettingsDefault(browserSection);
        const searchDefault = cloneJsonSettingsDefault(searchSection);

        expect(browserDefault).toMatchObject({ defaultHomepage: 'https://touch-ai.org' });
        expect(searchDefault).toMatchObject({ defaultProvider: 'anysearch' });
        expect(parseJsonSettingsValue(browserSection, false)).toEqual(browserDefault);
        expect(parseJsonSettingsValue(searchSection, '{bad json')).toEqual(searchDefault);
    });

    it('serializes section values with each section normalizer', () => {
        const searchSection = findJsonSettingsSection('search_settings');

        expect(searchSection).not.toBeNull();
        if (!searchSection) {
            throw new Error('expected search settings section to be registered');
        }

        const value = {
            ...cloneJsonSettingsDefault(searchSection),
            maxResults: 99,
        };

        expect(JSON.parse(serializeJsonSettingsValue(searchSection, value))).toMatchObject({
            maxResults: 10,
        });
    });

    it('validates section values through a shared registry entry point', () => {
        const browserSection = findJsonSettingsSection('browser_settings');
        const searchSection = findJsonSettingsSection('search_settings');

        expect(browserSection).not.toBeNull();
        expect(searchSection).not.toBeNull();
        if (!browserSection || !searchSection) {
            throw new Error('expected json settings sections to be registered');
        }

        expect(
            validateJsonSettingsValue(browserSection, {
                ...cloneJsonSettingsDefault(browserSection),
                defaultHomepage: 'ftp://touch-ai.org',
            })
        ).toContainEqual(expect.objectContaining({ path: 'defaultHomepage' }));

        const searchValue = cloneJsonSettingsDefault(searchSection) as SearchSettingsConfig;
        searchValue.providers.brave.enabled = true;
        searchValue.providers.brave.apiKey = '';

        expect(validateJsonSettingsValue(searchSection, searchValue)).toContainEqual(
            expect.objectContaining({ path: 'providers.brave.apiKey' })
        );
    });
});
