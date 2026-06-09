import type { GeneralSettingKey, SettingsGeneralUpdatedEvent } from '@services/EventService';
import { computed, type ComputedRef, type Ref } from 'vue';

import { type AppUpdateChannel, normalizeAppUpdateChannel } from '@/config/appUpdate';
import {
    type BrowserSettingsConfig,
    serializeBrowserSettingsConfig,
} from '@/config/browserSettings';
import { type SearchSettingsConfig, serializeSearchSettingsConfig } from '@/config/searchSettings';
import type { SearchWindowDefaultSize, SearchWindowSizePreset } from '@/config/searchWindow';
import { type AppLocale, normalizeLocale } from '@/i18n';

import type { GeneralSettingsData, OutputScrollBehavior } from './settingsDefinitions';

type GeneralSettingValue = SettingsGeneralUpdatedEvent['value'];

type GeneralSettingUpdateRunner = (
    key: GeneralSettingKey,
    value: GeneralSettingValue
) => Promise<void>;

type GeneralSettingsComputedRefMap = Record<
    keyof GeneralSettingsComputedRefs,
    ComputedRef<unknown>
>;
type GeneralSettingUpdaterMap = Record<
    keyof GeneralSettingUpdaters,
    (value: unknown) => Promise<void>
>;

export interface GeneralSettingsComputedRefs {
    outputScrollBehavior: ComputedRef<OutputScrollBehavior>;
    globalShortcut: ComputedRef<string>;
    searchWindowSizePreset: ComputedRef<SearchWindowSizePreset>;
    searchWindowDefaultSize: ComputedRef<SearchWindowDefaultSize>;
    language: ComputedRef<AppLocale>;
    appUpdateChannel: ComputedRef<AppUpdateChannel>;
    appUpdateAutoCheck: ComputedRef<boolean>;
    appUpdateLastCheckedAt: ComputedRef<string | null>;
    browserSettings: ComputedRef<BrowserSettingsConfig>;
    searchSettings: ComputedRef<SearchSettingsConfig>;
}

export interface GeneralSettingUpdaters {
    updateGlobalShortcut(shortcut: string): Promise<void>;
    updateStartOnBoot(enabled: boolean): Promise<void>;
    updateStartMinimized(enabled: boolean): Promise<void>;
    updateOutputScrollBehavior(mode: OutputScrollBehavior): Promise<void>;
    updateSearchWindowSizePreset(preset: SearchWindowSizePreset): Promise<void>;
    updateLanguage(language: AppLocale): Promise<void>;
    updateAppUpdateChannel(channel: AppUpdateChannel): Promise<void>;
    updateAppUpdateAutoCheck(enabled: boolean): Promise<void>;
    updateAppUpdateLastCheckedAt(checkedAt: string | null): Promise<void>;
    updateBrowserSettings(config: BrowserSettingsConfig): Promise<void>;
    updateSearchSettings(config: SearchSettingsConfig): Promise<void>;
}

interface GeneralSettingComputedBinding {
    exposedName: keyof GeneralSettingsComputedRefs;
    stateKey: keyof GeneralSettingsData;
}

interface GeneralSettingUpdaterBinding {
    exposedName: keyof GeneralSettingUpdaters;
    key: GeneralSettingKey;
    normalize(value: unknown): GeneralSettingValue;
}

export const GENERAL_SETTING_COMPUTED_BINDINGS: readonly GeneralSettingComputedBinding[] = [
    { exposedName: 'outputScrollBehavior', stateKey: 'outputScrollBehavior' },
    { exposedName: 'globalShortcut', stateKey: 'globalShortcut' },
    { exposedName: 'searchWindowSizePreset', stateKey: 'searchWindowSizePreset' },
    { exposedName: 'searchWindowDefaultSize', stateKey: 'searchWindowDefaultSize' },
    { exposedName: 'language', stateKey: 'language' },
    { exposedName: 'appUpdateChannel', stateKey: 'appUpdateChannel' },
    { exposedName: 'appUpdateAutoCheck', stateKey: 'appUpdateAutoCheck' },
    { exposedName: 'appUpdateLastCheckedAt', stateKey: 'appUpdateLastCheckedAt' },
    { exposedName: 'browserSettings', stateKey: 'browserSettings' },
    { exposedName: 'searchSettings', stateKey: 'searchSettings' },
];

export const GENERAL_SETTING_UPDATER_BINDINGS: readonly GeneralSettingUpdaterBinding[] = [
    { exposedName: 'updateGlobalShortcut', key: 'global_shortcut', normalize: String },
    { exposedName: 'updateStartOnBoot', key: 'start_on_boot', normalize: Boolean },
    { exposedName: 'updateStartMinimized', key: 'start_minimized', normalize: Boolean },
    { exposedName: 'updateOutputScrollBehavior', key: 'output_scroll_behavior', normalize: String },
    {
        exposedName: 'updateSearchWindowSizePreset',
        key: 'search_window_size_preset',
        normalize: String,
    },
    { exposedName: 'updateLanguage', key: 'language', normalize: normalizeLocale },
    {
        exposedName: 'updateAppUpdateChannel',
        key: 'app_update_channel',
        normalize: normalizeAppUpdateChannel,
    },
    { exposedName: 'updateAppUpdateAutoCheck', key: 'app_update_auto_check', normalize: Boolean },
    {
        exposedName: 'updateAppUpdateLastCheckedAt',
        key: 'app_update_last_checked_at',
        normalize: (value) => (value === null ? null : String(value)),
    },
    {
        exposedName: 'updateBrowserSettings',
        key: 'browser_settings',
        normalize: (value) => serializeBrowserSettingsConfig(value as BrowserSettingsConfig),
    },
    {
        exposedName: 'updateSearchSettings',
        key: 'search_settings',
        normalize: (value) => serializeSearchSettingsConfig(value as SearchSettingsConfig),
    },
];

export function createGeneralSettingsComputedRefs(
    settings: Ref<GeneralSettingsData>
): GeneralSettingsComputedRefs {
    const refs: Partial<GeneralSettingsComputedRefMap> = {};
    for (const binding of GENERAL_SETTING_COMPUTED_BINDINGS) {
        refs[binding.exposedName] = computed(() => settings.value[binding.stateKey]);
    }
    return refs as GeneralSettingsComputedRefs;
}

export function createGeneralSettingUpdaters(
    updateSetting: GeneralSettingUpdateRunner
): GeneralSettingUpdaters {
    const updaters: Partial<GeneralSettingUpdaterMap> = {};
    for (const binding of GENERAL_SETTING_UPDATER_BINDINGS) {
        updaters[binding.exposedName] = (value) =>
            updateSetting(binding.key, binding.normalize(value));
    }
    return updaters as GeneralSettingUpdaters;
}
