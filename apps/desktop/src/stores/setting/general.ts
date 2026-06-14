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
    OutputScrollBehavior,
    ScalarSettingDefinitionOptions,
} from './index';

const outputScrollBehaviorSchema = z.enum(['follow_output', 'stay_position', 'jump_to_top']);
const searchWindowSizePresetSchema = z.enum(
    Object.keys(SearchWindowSizePresets) as [SearchWindowSizePreset, ...SearchWindowSizePreset[]]
);

const DEFAULT_GLOBAL_SHORTCUT = 'Alt+Space';
const DEFAULT_OUTPUT_SCROLL_BEHAVIOR: OutputScrollBehavior = 'follow_output';
const DEFAULT_LANGUAGE: AppLocale = 'zh-CN';
const DEFAULT_SEARCH_WINDOW_DEFAULT_SIZE = resolveSearchWindowDefaultSize(
    DEFAULT_SEARCH_WINDOW_SIZE_PRESET
);

function normalizeOutputScrollBehavior(value: string | null): OutputScrollBehavior {
    const result = outputScrollBehaviorSchema.safeParse(value);
    return result.success ? result.data : DEFAULT_OUTPUT_SCROLL_BEHAVIOR;
}

function normalizeSearchWindowSizePreset(value: string | null): SearchWindowSizePreset {
    const result = searchWindowSizePresetSchema.safeParse(value);
    return result.success ? result.data : DEFAULT_SEARCH_WINDOW_SIZE_PRESET;
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

export const GENERAL_SCALAR_SETTING_SPECS = [
    {
        key: 'global_shortcut',
        stateKey: 'globalShortcut',
        defaultValue: DEFAULT_GLOBAL_SHORTCUT,
        parsePersisted: (raw) => stringValue(raw, DEFAULT_GLOBAL_SHORTCUT),
        parseUpdate: (value) => stringValue(value, DEFAULT_GLOBAL_SHORTCUT),
        store: {
            computedName: 'globalShortcut',
            updaterName: 'updateGlobalShortcut',
            normalizeUpdate: String,
        },
    },
    {
        key: 'start_on_boot',
        stateKey: 'startOnBoot',
        defaultValue: false,
        parsePersisted: (raw) => booleanFromString(raw, false),
        parseUpdate: (value) => booleanFromString(value, false),
        eventValue: (value) => value as boolean,
        store: {
            updaterName: 'updateStartOnBoot',
            normalizeUpdate: Boolean,
        },
    },
    {
        key: 'start_minimized',
        stateKey: 'startMinimized',
        defaultValue: true,
        parsePersisted: (raw) => booleanFromString(raw, true),
        parseUpdate: (value) => booleanFromString(value, true),
        eventValue: (value) => value as boolean,
        store: {
            updaterName: 'updateStartMinimized',
            normalizeUpdate: Boolean,
        },
    },
    {
        key: 'output_scroll_behavior',
        stateKey: 'outputScrollBehavior',
        defaultValue: DEFAULT_OUTPUT_SCROLL_BEHAVIOR,
        parsePersisted: normalizeOutputScrollBehavior,
        parseUpdate: (value) => normalizeOutputScrollBehavior(String(value)),
        store: {
            computedName: 'outputScrollBehavior',
            updaterName: 'updateOutputScrollBehavior',
            normalizeUpdate: String,
        },
    },
    {
        key: 'search_window_size_preset',
        stateKey: 'searchWindowSizePreset',
        defaultValue: DEFAULT_SEARCH_WINDOW_SIZE_PRESET,
        parsePersisted: normalizeSearchWindowSizePreset,
        parseUpdate: (value) => normalizeSearchWindowSizePreset(String(value)),
        afterApply: (target, value) => {
            target.searchWindowDefaultSize = {
                ...resolveSearchWindowDefaultSize(value as SearchWindowSizePreset),
            };
        },
        store: {
            computedName: 'searchWindowSizePreset',
            updaterName: 'updateSearchWindowSizePreset',
            normalizeUpdate: String,
        },
    },
    {
        key: 'language',
        stateKey: 'language',
        defaultValue: DEFAULT_LANGUAGE,
        parsePersisted: (raw) => (raw === null ? resolveFirstLaunchLocale() : normalizeLocale(raw)),
        parseUpdate: normalizeLocale,
        afterApply: (_target, value) => setLocale(value as AppLocale),
        persistBeforeApply: true,
        store: {
            computedName: 'language',
            updaterName: 'updateLanguage',
            normalizeUpdate: normalizeLocale,
        },
    },
    {
        key: 'app_update_channel',
        stateKey: 'appUpdateChannel',
        defaultValue: DEFAULT_APP_UPDATE_CHANNEL,
        parsePersisted: normalizeAppUpdateChannel,
        parseUpdate: normalizeAppUpdateChannel,
        store: {
            computedName: 'appUpdateChannel',
            updaterName: 'updateAppUpdateChannel',
            normalizeUpdate: normalizeAppUpdateChannel,
        },
    },
    {
        key: 'app_update_auto_check',
        stateKey: 'appUpdateAutoCheck',
        defaultValue: true,
        parsePersisted: (raw) => booleanNotFalse(raw, true),
        parseUpdate: (value) => booleanNotFalse(value, true),
        eventValue: (value) => value as boolean,
        store: {
            computedName: 'appUpdateAutoCheck',
            updaterName: 'updateAppUpdateAutoCheck',
            normalizeUpdate: Boolean,
        },
    },
    {
        key: 'app_update_last_checked_at',
        stateKey: 'appUpdateLastCheckedAt',
        defaultValue: null,
        parsePersisted: (raw) => raw || null,
        parseUpdate: nullableString,
        serializeValue: (value) => (value as string | null) ?? '',
        eventValue: (value) => value as string | null,
        store: {
            computedName: 'appUpdateLastCheckedAt',
            updaterName: 'updateAppUpdateLastCheckedAt',
            normalizeUpdate: (value) => (value === null ? null : String(value)),
        },
    },
] as const satisfies readonly ScalarSettingDefinitionOptions[];

export type GeneralScalarSettingKey = (typeof GENERAL_SCALAR_SETTING_SPECS)[number]['key'];

export const GENERAL_SETTINGS_DEFAULTS = {
    ...Object.fromEntries(
        GENERAL_SCALAR_SETTING_SPECS.map((setting) => [setting.stateKey, setting.defaultValue])
    ),
    searchWindowDefaultSize: { ...DEFAULT_SEARCH_WINDOW_DEFAULT_SIZE },
} as Omit<GeneralSettingsData, 'browserSettings' | 'searchSettings'>;

export const GENERAL_DERIVED_COMPUTED_BINDINGS: readonly GeneralSettingComputedBinding[] = [
    { exposedName: 'searchWindowDefaultSize', stateKey: 'searchWindowDefaultSize' },
];
