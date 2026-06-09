import type { GeneralSettingKey, SettingsGeneralUpdatedEvent } from '@services/EventService';
import { computed, type ComputedRef, type Ref } from 'vue';

import {
    type AppUpdateChannel,
    DEFAULT_APP_UPDATE_CHANNEL,
    normalizeAppUpdateChannel,
} from '@/config/appUpdate';
import {
    type BrowserSettingsConfig,
    DEFAULT_BROWSER_SETTINGS,
    serializeBrowserSettingsConfig,
} from '@/config/browserSettings';
import {
    DEFAULT_SEARCH_SETTINGS,
    type SearchSettingsConfig,
    serializeSearchSettingsConfig,
} from '@/config/searchSettings';
import {
    DEFAULT_SEARCH_WINDOW_SIZE_PRESET,
    resolveSearchWindowDefaultSize,
    type SearchWindowDefaultSize,
    type SearchWindowSizePreset,
    SearchWindowSizePreset as SearchWindowSizePresets,
} from '@/config/searchWindow';
import {
    cloneJsonSettingsDefault,
    JSON_SETTINGS_SECTIONS,
    parseJsonSettingsValue,
    type RegisteredJsonSettingsSection,
    type RegisteredJsonSettingsValue,
    serializeJsonSettingsValue,
} from '@/config/settingsRegistry';
import { type AppLocale, normalizeLocale, resolveFirstLaunchLocale, setLocale } from '@/i18n';
import { z } from '@/utils/zod';

export type OutputScrollBehavior = 'follow_output' | 'stay_position' | 'jump_to_top';

export interface GeneralSettingsData {
    globalShortcut: string;
    startOnBoot: boolean;
    startMinimized: boolean;
    outputScrollBehavior: OutputScrollBehavior;
    searchWindowSizePreset: SearchWindowSizePreset;
    searchWindowDefaultSize: SearchWindowDefaultSize;
    language: AppLocale;
    appUpdateChannel: AppUpdateChannel;
    appUpdateAutoCheck: boolean;
    appUpdateLastCheckedAt: string | null;
    browserSettings: BrowserSettingsConfig;
    searchSettings: SearchSettingsConfig;
}

type GeneralSettingValue = SettingsGeneralUpdatedEvent['value'];

type GeneralSettingUpdateRunner = (
    key: GeneralSettingKey,
    value: GeneralSettingValue
) => Promise<void>;

type GeneralSettingFieldValue =
    | string
    | boolean
    | null
    | BrowserSettingsConfig
    | SearchSettingsConfig;

type GeneralSettingStateKey = Exclude<keyof GeneralSettingsData, 'searchWindowDefaultSize'>;

type GeneralSettingsComputedRefMap = Record<
    keyof GeneralSettingsComputedRefs,
    ComputedRef<unknown>
>;
type GeneralSettingUpdaterMap = Record<
    keyof GeneralSettingUpdaters,
    (value: unknown) => Promise<void>
>;

export interface GeneralSettingDefinition {
    key: GeneralSettingKey;
    parsePersisted(raw: string | null): GeneralSettingFieldValue;
    parseUpdate(value: GeneralSettingValue): GeneralSettingFieldValue;
    apply(target: GeneralSettingsData, value: GeneralSettingFieldValue): void;
    read(source: GeneralSettingsData): GeneralSettingFieldValue;
    serializeValue(value: GeneralSettingFieldValue): string;
    eventValue(value: GeneralSettingFieldValue): GeneralSettingValue;
    persistBeforeApply?: boolean;
}

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

interface ScalarSettingDefinitionOptions {
    key: GeneralSettingKey;
    stateKey: GeneralSettingStateKey;
    parsePersisted(raw: string | null): GeneralSettingFieldValue;
    parseUpdate(value: GeneralSettingValue): GeneralSettingFieldValue;
    serializeValue?(value: GeneralSettingFieldValue): string;
    eventValue?(value: GeneralSettingFieldValue): GeneralSettingValue;
    afterApply?(target: GeneralSettingsData, value: GeneralSettingFieldValue): void;
    persistBeforeApply?: boolean;
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

const outputScrollBehaviorSchema = z.enum(['follow_output', 'stay_position', 'jump_to_top']);
const searchWindowSizePresetSchema = z.enum(
    Object.keys(SearchWindowSizePresets) as [SearchWindowSizePreset, ...SearchWindowSizePreset[]]
);

const DEFAULT_GENERAL_SETTINGS: GeneralSettingsData = {
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
    browserSettings: DEFAULT_BROWSER_SETTINGS,
    searchSettings: DEFAULT_SEARCH_SETTINGS,
};

function normalizeOutputScrollBehavior(value: string | null): OutputScrollBehavior {
    const result = outputScrollBehaviorSchema.safeParse(value);
    return result.success ? result.data : DEFAULT_GENERAL_SETTINGS.outputScrollBehavior;
}

function normalizeSearchWindowSizePreset(value: string | null): SearchWindowSizePreset {
    const result = searchWindowSizePresetSchema.safeParse(value);
    return result.success ? result.data : DEFAULT_GENERAL_SETTINGS.searchWindowSizePreset;
}

function booleanFromString(
    value: GeneralSettingValue,
    defaultValue: boolean,
    trueWhenMissing = defaultValue
): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (value === null) {
        return trueWhenMissing;
    }
    return String(value) === 'true';
}

function booleanNotFalse(value: GeneralSettingValue, defaultValue: boolean): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (value === null) {
        return defaultValue;
    }
    return String(value) !== 'false';
}

function applySearchWindowSizePreset(
    target: GeneralSettingsData,
    preset: SearchWindowSizePreset
): void {
    target.searchWindowDefaultSize = { ...resolveSearchWindowDefaultSize(preset) };
}

function assignGeneralSettingField(
    target: GeneralSettingsData,
    stateKey: GeneralSettingStateKey,
    value: GeneralSettingFieldValue
): void {
    (target as unknown as Record<GeneralSettingStateKey, GeneralSettingFieldValue>)[stateKey] =
        value;
}

function readGeneralSettingField(
    source: GeneralSettingsData,
    stateKey: GeneralSettingStateKey
): GeneralSettingFieldValue {
    return (source as unknown as Record<GeneralSettingStateKey, GeneralSettingFieldValue>)[
        stateKey
    ];
}

function stringValue(value: GeneralSettingValue, fallback: string): string {
    return String(value || fallback);
}

function nullableString(value: GeneralSettingValue): string | null {
    return value === null ? null : String(value);
}

function scalarSettingDefinition(
    options: ScalarSettingDefinitionOptions
): GeneralSettingDefinition {
    return {
        key: options.key,
        parsePersisted: options.parsePersisted,
        parseUpdate: options.parseUpdate,
        apply: (target, value) => {
            assignGeneralSettingField(target, options.stateKey, value);
            options.afterApply?.(target, value);
        },
        read: (source) => readGeneralSettingField(source, options.stateKey),
        serializeValue: options.serializeValue ?? String,
        eventValue: options.eventValue ?? String,
        persistBeforeApply: options.persistBeforeApply,
    };
}

function jsonSettingDefinition(section: RegisteredJsonSettingsSection): GeneralSettingDefinition {
    return {
        key: section.key,
        parsePersisted: (raw) => parseJsonSettingsValue(section, raw),
        parseUpdate: (value) => parseJsonSettingsValue(section, value),
        apply: (target, value) => assignGeneralSettingField(target, section.stateKey, value),
        read: (source) =>
            readGeneralSettingField(source, section.stateKey) as RegisteredJsonSettingsValue,
        serializeValue: (value) =>
            serializeJsonSettingsValue(section, value as RegisteredJsonSettingsValue),
        eventValue: (value) =>
            serializeJsonSettingsValue(section, value as RegisteredJsonSettingsValue),
    };
}

export const JSON_GENERAL_SETTING_DEFINITIONS: readonly GeneralSettingDefinition[] =
    JSON_SETTINGS_SECTIONS.map(jsonSettingDefinition);

export const GENERAL_SETTING_DEFINITIONS: readonly GeneralSettingDefinition[] = [
    scalarSettingDefinition({
        key: 'global_shortcut',
        stateKey: 'globalShortcut',
        parsePersisted: (raw) => stringValue(raw, DEFAULT_GENERAL_SETTINGS.globalShortcut),
        parseUpdate: (value) => stringValue(value, DEFAULT_GENERAL_SETTINGS.globalShortcut),
    }),
    scalarSettingDefinition({
        key: 'start_on_boot',
        stateKey: 'startOnBoot',
        parsePersisted: (raw) => booleanFromString(raw, DEFAULT_GENERAL_SETTINGS.startOnBoot),
        parseUpdate: (value) => booleanFromString(value, DEFAULT_GENERAL_SETTINGS.startOnBoot),
        eventValue: (value) => value as boolean,
    }),
    scalarSettingDefinition({
        key: 'start_minimized',
        stateKey: 'startMinimized',
        parsePersisted: (raw) => booleanFromString(raw, DEFAULT_GENERAL_SETTINGS.startMinimized),
        parseUpdate: (value) => booleanFromString(value, DEFAULT_GENERAL_SETTINGS.startMinimized),
        eventValue: (value) => value as boolean,
    }),
    scalarSettingDefinition({
        key: 'output_scroll_behavior',
        stateKey: 'outputScrollBehavior',
        parsePersisted: normalizeOutputScrollBehavior,
        parseUpdate: (value) => normalizeOutputScrollBehavior(String(value)),
    }),
    scalarSettingDefinition({
        key: 'search_window_size_preset',
        stateKey: 'searchWindowSizePreset',
        parsePersisted: normalizeSearchWindowSizePreset,
        parseUpdate: (value) => normalizeSearchWindowSizePreset(String(value)),
        afterApply: (target, value) =>
            applySearchWindowSizePreset(target, value as SearchWindowSizePreset),
    }),
    scalarSettingDefinition({
        key: 'language',
        stateKey: 'language',
        parsePersisted: (raw) => (raw === null ? resolveFirstLaunchLocale() : normalizeLocale(raw)),
        parseUpdate: normalizeLocale,
        afterApply: (_target, value) => setLocale(value as AppLocale),
        persistBeforeApply: true,
    }),
    scalarSettingDefinition({
        key: 'app_update_channel',
        stateKey: 'appUpdateChannel',
        parsePersisted: normalizeAppUpdateChannel,
        parseUpdate: normalizeAppUpdateChannel,
    }),
    scalarSettingDefinition({
        key: 'app_update_auto_check',
        stateKey: 'appUpdateAutoCheck',
        parsePersisted: (raw) => booleanNotFalse(raw, DEFAULT_GENERAL_SETTINGS.appUpdateAutoCheck),
        parseUpdate: (value) => booleanNotFalse(value, DEFAULT_GENERAL_SETTINGS.appUpdateAutoCheck),
        eventValue: (value) => value as boolean,
    }),
    scalarSettingDefinition({
        key: 'app_update_last_checked_at',
        stateKey: 'appUpdateLastCheckedAt',
        parsePersisted: (raw) => raw || null,
        parseUpdate: nullableString,
        serializeValue: (value) => (value as string | null) ?? '',
        eventValue: (value) => value as string | null,
    }),
    ...JSON_GENERAL_SETTING_DEFINITIONS,
];

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

const generalSettingDefinitionByKey = new Map(
    GENERAL_SETTING_DEFINITIONS.map((definition) => [definition.key, definition])
);

export function getGeneralSettingDefinition(
    key: GeneralSettingKey
): GeneralSettingDefinition | null {
    return generalSettingDefinitionByKey.get(key) ?? null;
}

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

export function createDefaultGeneralSettings(): GeneralSettingsData {
    const defaults: GeneralSettingsData = {
        ...DEFAULT_GENERAL_SETTINGS,
        searchWindowDefaultSize: { ...DEFAULT_GENERAL_SETTINGS.searchWindowDefaultSize },
    };
    for (const section of JSON_SETTINGS_SECTIONS) {
        assignGeneralSettingField(defaults, section.stateKey, cloneJsonSettingsDefault(section));
    }
    return defaults;
}

export function cloneGeneralSettingsSnapshot(source: GeneralSettingsData): GeneralSettingsData {
    const snapshot: GeneralSettingsData = {
        ...source,
        searchWindowDefaultSize: { ...source.searchWindowDefaultSize },
    };
    for (const section of JSON_SETTINGS_SECTIONS) {
        assignGeneralSettingField(
            snapshot,
            section.stateKey,
            parseJsonSettingsValue(
                section,
                serializeJsonSettingsValue(
                    section,
                    readGeneralSettingField(source, section.stateKey) as RegisteredJsonSettingsValue
                )
            )
        );
    }
    return snapshot;
}

export function applyGeneralSettingValue(
    target: GeneralSettingsData,
    key: GeneralSettingKey,
    value: GeneralSettingValue
): void {
    const definition = requireGeneralSettingDefinition(key);
    definition.apply(target, definition.parseUpdate(value));
}

export function applyPersistedGeneralSettingValue(
    target: GeneralSettingsData,
    key: GeneralSettingKey,
    value: string | null
): void {
    const definition = requireGeneralSettingDefinition(key);
    definition.apply(target, definition.parsePersisted(value));
}

export function serializeGeneralSetting(
    source: GeneralSettingsData,
    key: GeneralSettingKey
): string {
    const definition = requireGeneralSettingDefinition(key);
    return definition.serializeValue(definition.read(source));
}

export function getGeneralSettingEventValue(
    source: GeneralSettingsData,
    key: GeneralSettingKey
): GeneralSettingValue {
    const definition = requireGeneralSettingDefinition(key);
    return definition.eventValue(definition.read(source));
}

export function parseGeneralSettingUpdateValue(
    key: GeneralSettingKey,
    value: GeneralSettingValue
): GeneralSettingFieldValue {
    return requireGeneralSettingDefinition(key).parseUpdate(value);
}

export function applyParsedGeneralSettingValue(
    target: GeneralSettingsData,
    key: GeneralSettingKey,
    value: GeneralSettingFieldValue
): void {
    requireGeneralSettingDefinition(key).apply(target, value);
}

export function serializeParsedGeneralSettingValue(
    key: GeneralSettingKey,
    value: GeneralSettingFieldValue
): string {
    return requireGeneralSettingDefinition(key).serializeValue(value);
}

function requireGeneralSettingDefinition(key: GeneralSettingKey): GeneralSettingDefinition {
    const definition = getGeneralSettingDefinition(key);
    if (!definition) {
        throw new Error(`Unknown general setting key: ${key}`);
    }
    return definition;
}
