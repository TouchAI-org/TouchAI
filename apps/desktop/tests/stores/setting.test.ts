import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import {
    applyGeneralSettingValue,
    applyPersistedGeneralSettingValue,
    cloneGeneralSettingsSnapshot,
    createDefaultGeneralSettings,
    createGeneralSettingsComputedRefs,
    createGeneralSettingUpdaters,
    GENERAL_SETTING_COMPUTED_BINDINGS,
    GENERAL_SETTING_DEFINITIONS,
    GENERAL_SETTING_UPDATER_BINDINGS,
    type GeneralSettingKey,
    type GeneralSettingValue,
    getGeneralSettingDefinition,
    getGeneralSettingEventValue,
    JSON_GENERAL_SETTING_DEFINITIONS,
    serializeGeneralSetting,
} from '@/stores/setting';
import { DEFAULT_BROWSER_SETTINGS } from '@/stores/setting/sections/browser';
import { JSON_SETTINGS_SECTIONS } from '@/stores/setting/sections/registry';
import { DEFAULT_SEARCH_SETTINGS } from '@/stores/setting/sections/search';

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
    'search_keybindings',
    'browser_settings',
    'search_settings',
];

describe('setting registry', () => {
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

    it('declares stable computed and updater bindings in the settings registry', () => {
        expect(GENERAL_SETTING_COMPUTED_BINDINGS.map((binding) => binding.exposedName)).toEqual([
            'globalShortcut',
            'outputScrollBehavior',
            'searchWindowSizePreset',
            'language',
            'appUpdateChannel',
            'appUpdateAutoCheck',
            'appUpdateLastCheckedAt',
            'searchKeybindings',
            'searchWindowDefaultSize',
            'browserSettings',
            'searchSettings',
        ]);

        expect(GENERAL_SETTING_UPDATER_BINDINGS.map((binding) => binding.exposedName)).toEqual([
            'updateGlobalShortcut',
            'updateStartOnBoot',
            'updateStartMinimized',
            'updateOutputScrollBehavior',
            'updateSearchWindowSizePreset',
            'updateLanguage',
            'updateAppUpdateChannel',
            'updateAppUpdateAutoCheck',
            'updateAppUpdateLastCheckedAt',
            'updateSearchKeybindings',
            'updateBrowserSettings',
            'updateSearchSettings',
        ]);
    });

    it('creates computed refs from declared state bindings', () => {
        const settings = ref(createDefaultGeneralSettings());
        const computedRefs = createGeneralSettingsComputedRefs(settings);

        expect(computedRefs.globalShortcut.value).toBe('Alt+Space');

        settings.value.globalShortcut = 'Ctrl+Space';

        expect(computedRefs.globalShortcut.value).toBe('Ctrl+Space');
    });

    it('creates updater methods from declared key bindings', async () => {
        const updateSetting = vi.fn(async (key: GeneralSettingKey, value: GeneralSettingValue) => {
            void key;
            void value;
        });
        const updaters = createGeneralSettingUpdaters(updateSetting);

        await updaters.updateGlobalShortcut('Ctrl+Space');
        await updaters.updateLanguage('en-US');
        await updaters.updateBrowserSettings({
            ...DEFAULT_BROWSER_SETTINGS,
            defaultHomepage: 'https://example.test',
        });
        await updaters.updateSearchSettings(DEFAULT_SEARCH_SETTINGS);

        expect(updateSetting).toHaveBeenNthCalledWith(1, 'global_shortcut', 'Ctrl+Space');
        expect(updateSetting).toHaveBeenNthCalledWith(2, 'language', 'en-US');
        expect(updateSetting).toHaveBeenNthCalledWith(
            3,
            'browser_settings',
            expect.stringContaining('https://example.test')
        );
        expect(updateSetting).toHaveBeenNthCalledWith(
            4,
            'search_settings',
            expect.stringContaining('providers')
        );
    });
});
