import {
    DEFAULT_SEARCH_SETTINGS,
    SEARCH_SETTINGS_KEY,
    type SearchSettingsConfig,
    serializeSearchSettingsConfig,
} from '@/config/searchSettings';

import type {
    GeneralSettingComputedBinding,
    GeneralSettingsData,
    GeneralSettingUpdaterBinding,
} from './index';

export const SEARCH_SETTINGS_DEFAULTS = {
    searchSettings: DEFAULT_SEARCH_SETTINGS,
} satisfies Pick<GeneralSettingsData, 'searchSettings'>;

export const SEARCH_JSON_SETTING_KEYS = [SEARCH_SETTINGS_KEY] as const;

export const SEARCH_COMPUTED_BINDINGS: readonly GeneralSettingComputedBinding[] = [
    { exposedName: 'searchSettings', stateKey: 'searchSettings' },
];

export const SEARCH_UPDATER_BINDINGS: readonly GeneralSettingUpdaterBinding[] = [
    {
        exposedName: 'updateSearchSettings',
        key: 'search_settings',
        normalize: (value) => serializeSearchSettingsConfig(value as SearchSettingsConfig),
    },
];
