import type { GeneralSettingKey } from '@services/EventService';
import { describe, expect, it } from 'vitest';

import { JSON_SETTINGS_SECTIONS } from '@/config/settingsRegistry';
import {
    applyGeneralSettingValue,
    applyPersistedGeneralSettingValue,
    cloneGeneralSettingsSnapshot,
    createDefaultGeneralSettings,
    GENERAL_SETTING_DEFINITIONS,
    getGeneralSettingDefinition,
    getGeneralSettingEventValue,
    JSON_GENERAL_SETTING_DEFINITIONS,
    serializeGeneralSetting,
} from '@/stores/settingsDefinitions';

const EXPECTED_GENERAL_SETTING_KEYS: GeneralSettingKey[] = [
    'global_shortcut',
    'start_on_boot',
    'start_minimized',
    'output_scroll_behavior',
    'search_window_size_preset',
    'language',
    'app_update_channel',
    'app_update_auto_check',
    'app_update_last_checked_at',
    'browser_settings',
    'search_settings',
];

describe('settings definitions', () => {
    it('declares every persisted general setting key in one registry', () => {
        expect(GENERAL_SETTING_DEFINITIONS.map((definition) => definition.key)).toEqual(
            EXPECTED_GENERAL_SETTING_KEYS
        );
        for (const key of EXPECTED_GENERAL_SETTING_KEYS) {
            expect(getGeneralSettingDefinition(key)?.key).toBe(key);
        }
        expect(getGeneralSettingDefinition('missing' as GeneralSettingKey)).toBeNull();
    });

    it('keeps definition keys unique so store load order is unambiguous', () => {
        const keys = GENERAL_SETTING_DEFINITIONS.map((definition) => definition.key);

        expect(new Set(keys).size).toBe(keys.length);
    });

    it('derives json-backed general settings from the json settings registry', () => {
        expect(JSON_GENERAL_SETTING_DEFINITIONS.map((definition) => definition.key)).toEqual(
            JSON_SETTINGS_SECTIONS.map((section) => section.key)
        );
    });

    it('applies, serializes, and exposes event values through definitions', () => {
        const settings = createDefaultGeneralSettings();

        applyGeneralSettingValue(settings, 'start_on_boot', 'true');
        expect(settings.startOnBoot).toBe(true);
        expect(serializeGeneralSetting(settings, 'start_on_boot')).toBe('true');
        expect(getGeneralSettingEventValue(settings, 'start_on_boot')).toBe(true);

        applyGeneralSettingValue(settings, 'search_window_size_preset', 'large');
        expect(settings.searchWindowSizePreset).toBe('large');
        expect(settings.searchWindowDefaultSize).toMatchObject({ width: 938 });

        applyGeneralSettingValue(
            settings,
            'browser_settings',
            JSON.stringify({ defaultHomepage: 'https://example.test' })
        );
        expect(settings.browserSettings.defaultHomepage).toBe('https://example.test');
        expect(serializeGeneralSetting(settings, 'browser_settings')).toContain(
            'https://example.test'
        );
    });

    it('normalizes invalid persisted scalar values back to declarative defaults', () => {
        const settings = createDefaultGeneralSettings();

        applyPersistedGeneralSettingValue(settings, 'output_scroll_behavior', 'invalid');
        applyPersistedGeneralSettingValue(settings, 'search_window_size_preset', 'invalid');
        applyPersistedGeneralSettingValue(settings, 'app_update_auto_check', 'false');

        expect(settings.outputScrollBehavior).toBe('follow_output');
        expect(settings.searchWindowSizePreset).toBe('normal');
        expect(settings.searchWindowDefaultSize).toMatchObject({ width: 750 });
        expect(settings.appUpdateAutoCheck).toBe(false);
    });

    it('keeps language as a persisted-before-apply setting', () => {
        expect(getGeneralSettingDefinition('language')).toMatchObject({
            persistBeforeApply: true,
        });
    });

    it('clones nested settings without sharing mutable references', () => {
        const settings = createDefaultGeneralSettings();
        const clone = cloneGeneralSettingsSnapshot(settings);

        clone.browserSettings.permissions.navigate = 'deny';
        clone.searchSettings.providers.anysearch.enabled = false;

        expect(settings.browserSettings.permissions.navigate).not.toBe('deny');
        expect(settings.searchSettings.providers.anysearch.enabled).toBe(true);
    });
});
