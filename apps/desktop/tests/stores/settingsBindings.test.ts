import type { GeneralSettingKey, SettingsGeneralUpdatedEvent } from '@services/EventService';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { DEFAULT_BROWSER_SETTINGS } from '@/config/browserSettings';
import { DEFAULT_SEARCH_SETTINGS } from '@/config/searchSettings';
import {
    createGeneralSettingsComputedRefs,
    createGeneralSettingUpdaters,
    GENERAL_SETTING_COMPUTED_BINDINGS,
    GENERAL_SETTING_UPDATER_BINDINGS,
} from '@/stores/settingsBindings';
import { createDefaultGeneralSettings } from '@/stores/settingsDefinitions';

type GeneralSettingValue = SettingsGeneralUpdatedEvent['value'];

describe('settings store bindings', () => {
    it('declares stable computed and updater bindings outside the store shell', () => {
        expect(GENERAL_SETTING_COMPUTED_BINDINGS.map((binding) => binding.exposedName)).toEqual([
            'outputScrollBehavior',
            'globalShortcut',
            'searchWindowSizePreset',
            'searchWindowDefaultSize',
            'language',
            'appUpdateChannel',
            'appUpdateAutoCheck',
            'appUpdateLastCheckedAt',
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
