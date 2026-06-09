import {
    BROWSER_SETTINGS_KEY,
    type BrowserSettingsConfig,
    DEFAULT_BROWSER_SETTINGS,
    serializeBrowserSettingsConfig,
} from '@/config/browserSettings';

import type {
    GeneralSettingComputedBinding,
    GeneralSettingsData,
    GeneralSettingUpdaterBinding,
} from './index';

export const BROWSER_SETTINGS_DEFAULTS = {
    browserSettings: DEFAULT_BROWSER_SETTINGS,
} satisfies Pick<GeneralSettingsData, 'browserSettings'>;

export const BROWSER_JSON_SETTING_KEYS = [BROWSER_SETTINGS_KEY] as const;

export const BROWSER_COMPUTED_BINDINGS: readonly GeneralSettingComputedBinding[] = [
    { exposedName: 'browserSettings', stateKey: 'browserSettings' },
];

export const BROWSER_UPDATER_BINDINGS: readonly GeneralSettingUpdaterBinding[] = [
    {
        exposedName: 'updateBrowserSettings',
        key: 'browser_settings',
        normalize: (value) => serializeBrowserSettingsConfig(value as BrowserSettingsConfig),
    },
];
