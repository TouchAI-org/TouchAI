import { DEFAULT_APP_UPDATE_CHANNEL, normalizeAppUpdateChannel } from '@/config/appUpdate';
import {
    DEFAULT_SEARCH_WINDOW_SIZE_PRESET,
    resolveSearchWindowDefaultSize,
    type SearchWindowSizePreset,
    SearchWindowSizePreset as SearchWindowSizePresets,
} from '@/config/searchWindow';
import { type AppLocale, normalizeLocale, resolveFirstLaunchLocale, setLocale } from '@/i18n';
import { z } from '@/utils/zod';

import type {
    GeneralSettingComputedBinding,
    GeneralSettingsData,
    GeneralSettingUpdaterBinding,
    OutputScrollBehavior,
    ScalarSettingDefinitionOptions,
} from './index';

export const GENERAL_SETTINGS_DEFAULTS = {
    globalShortcut: 'Alt+Space',
    startOnBoot: false,
    startMinimized: true,
    outputScrollBehavior: 'follow_output',
    searchWindowSizePreset: DEFAULT_SEARCH_WINDOW_SIZE_PRESET,
    searchWindowDefaultSize: resolveSearchWindowDefaultSize(DEFAULT_SEARCH_WINDOW_SIZE_PRESET),
    language: 'zh-CN',
    appUpdateChannel: DEFAULT_APP_UPDATE_CHANNEL,
    appUpdateAutoCheck: true,
    appUpdateLastCheckedAt: null,
} satisfies Omit<GeneralSettingsData, 'browserSettings' | 'searchSettings'>;

const outputScrollBehaviorSchema = z.enum(['follow_output', 'stay_position', 'jump_to_top']);
const searchWindowSizePresetSchema = z.enum(
    Object.keys(SearchWindowSizePresets) as [SearchWindowSizePreset, ...SearchWindowSizePreset[]]
);

function normalizeOutputScrollBehavior(value: string | null): OutputScrollBehavior {
    const result = outputScrollBehaviorSchema.safeParse(value);
    return result.success ? result.data : GENERAL_SETTINGS_DEFAULTS.outputScrollBehavior;
}

function normalizeSearchWindowSizePreset(value: string | null): SearchWindowSizePreset {
    const result = searchWindowSizePresetSchema.safeParse(value);
    return result.success ? result.data : GENERAL_SETTINGS_DEFAULTS.searchWindowSizePreset;
}

function booleanFromString(value: unknown, defaultValue: boolean): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (value === null) {
        return defaultValue;
    }
    return String(value) === 'true';
}

function booleanNotFalse(value: unknown, defaultValue: boolean): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (value === null) {
        return defaultValue;
    }
    return String(value) !== 'false';
}

function stringValue(value: unknown, fallback: string): string {
    return String(value || fallback);
}

function nullableString(value: unknown): string | null {
    return value === null ? null : String(value);
}

export const GENERAL_SCALAR_SETTING_SPECS: readonly ScalarSettingDefinitionOptions[] = [
    {
        key: 'global_shortcut',
        stateKey: 'globalShortcut',
        parsePersisted: (raw) => stringValue(raw, GENERAL_SETTINGS_DEFAULTS.globalShortcut),
        parseUpdate: (value) => stringValue(value, GENERAL_SETTINGS_DEFAULTS.globalShortcut),
    },
    {
        key: 'start_on_boot',
        stateKey: 'startOnBoot',
        parsePersisted: (raw) => booleanFromString(raw, GENERAL_SETTINGS_DEFAULTS.startOnBoot),
        parseUpdate: (value) => booleanFromString(value, GENERAL_SETTINGS_DEFAULTS.startOnBoot),
        eventValue: (value) => value as boolean,
    },
    {
        key: 'start_minimized',
        stateKey: 'startMinimized',
        parsePersisted: (raw) => booleanFromString(raw, GENERAL_SETTINGS_DEFAULTS.startMinimized),
        parseUpdate: (value) => booleanFromString(value, GENERAL_SETTINGS_DEFAULTS.startMinimized),
        eventValue: (value) => value as boolean,
    },
    {
        key: 'output_scroll_behavior',
        stateKey: 'outputScrollBehavior',
        parsePersisted: normalizeOutputScrollBehavior,
        parseUpdate: (value) => normalizeOutputScrollBehavior(String(value)),
    },
    {
        key: 'search_window_size_preset',
        stateKey: 'searchWindowSizePreset',
        parsePersisted: normalizeSearchWindowSizePreset,
        parseUpdate: (value) => normalizeSearchWindowSizePreset(String(value)),
        afterApply: (target, value) => {
            target.searchWindowDefaultSize = {
                ...resolveSearchWindowDefaultSize(value as SearchWindowSizePreset),
            };
        },
    },
    {
        key: 'language',
        stateKey: 'language',
        parsePersisted: (raw) => (raw === null ? resolveFirstLaunchLocale() : normalizeLocale(raw)),
        parseUpdate: normalizeLocale,
        afterApply: (_target, value) => setLocale(value as AppLocale),
        persistBeforeApply: true,
    },
    {
        key: 'app_update_channel',
        stateKey: 'appUpdateChannel',
        parsePersisted: normalizeAppUpdateChannel,
        parseUpdate: normalizeAppUpdateChannel,
    },
    {
        key: 'app_update_auto_check',
        stateKey: 'appUpdateAutoCheck',
        parsePersisted: (raw) => booleanNotFalse(raw, GENERAL_SETTINGS_DEFAULTS.appUpdateAutoCheck),
        parseUpdate: (value) =>
            booleanNotFalse(value, GENERAL_SETTINGS_DEFAULTS.appUpdateAutoCheck),
        eventValue: (value) => value as boolean,
    },
    {
        key: 'app_update_last_checked_at',
        stateKey: 'appUpdateLastCheckedAt',
        parsePersisted: (raw) => raw || null,
        parseUpdate: nullableString,
        serializeValue: (value) => (value as string | null) ?? '',
        eventValue: (value) => value as string | null,
    },
];

export const GENERAL_COMPUTED_BINDINGS: readonly GeneralSettingComputedBinding[] = [
    { exposedName: 'outputScrollBehavior', stateKey: 'outputScrollBehavior' },
    { exposedName: 'globalShortcut', stateKey: 'globalShortcut' },
    { exposedName: 'searchWindowSizePreset', stateKey: 'searchWindowSizePreset' },
    { exposedName: 'searchWindowDefaultSize', stateKey: 'searchWindowDefaultSize' },
    { exposedName: 'language', stateKey: 'language' },
    { exposedName: 'appUpdateChannel', stateKey: 'appUpdateChannel' },
    { exposedName: 'appUpdateAutoCheck', stateKey: 'appUpdateAutoCheck' },
    { exposedName: 'appUpdateLastCheckedAt', stateKey: 'appUpdateLastCheckedAt' },
];

export const GENERAL_UPDATER_BINDINGS: readonly GeneralSettingUpdaterBinding[] = [
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
];
