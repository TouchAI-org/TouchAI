import type { GeneralSettingKey, SettingsGeneralUpdatedEvent } from '@services/EventService';
import { computed, type ComputedRef, type Ref } from 'vue';

import type { AppUpdateChannel } from '@/config/appUpdate';
import type { BrowserSettingsConfig } from '@/config/browserSettings';
import type { SearchSettingsConfig } from '@/config/searchSettings';
import type { SearchWindowDefaultSize, SearchWindowSizePreset } from '@/config/searchWindow';
import {
    cloneJsonSettingsDefault,
    findJsonSettingsSection,
    parseJsonSettingsValue,
    type RegisteredJsonSettingsSection,
    type RegisteredJsonSettingsValue,
    serializeJsonSettingsValue,
} from '@/config/settingsRegistry';
import type { AppLocale } from '@/i18n';

import {
    BROWSER_COMPUTED_BINDINGS,
    BROWSER_JSON_SETTING_KEYS,
    BROWSER_SETTINGS_DEFAULTS,
    BROWSER_UPDATER_BINDINGS,
} from './browser';
import {
    GENERAL_COMPUTED_BINDINGS,
    GENERAL_SCALAR_SETTING_SPECS,
    GENERAL_SETTINGS_DEFAULTS,
    GENERAL_UPDATER_BINDINGS,
} from './general';
import {
    SEARCH_COMPUTED_BINDINGS,
    SEARCH_JSON_SETTING_KEYS,
    SEARCH_SETTINGS_DEFAULTS,
    SEARCH_UPDATER_BINDINGS,
} from './search';

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

export interface ScalarSettingDefinitionOptions {
    key: GeneralSettingKey;
    stateKey: GeneralSettingStateKey;
    parsePersisted(raw: string | null): GeneralSettingFieldValue;
    parseUpdate(value: GeneralSettingValue): GeneralSettingFieldValue;
    serializeValue?(value: GeneralSettingFieldValue): string;
    eventValue?(value: GeneralSettingFieldValue): GeneralSettingValue;
    afterApply?(target: GeneralSettingsData, value: GeneralSettingFieldValue): void;
    persistBeforeApply?: boolean;
}

export interface GeneralSettingComputedBinding {
    exposedName: keyof GeneralSettingsComputedRefs;
    stateKey: keyof GeneralSettingsData;
}

export interface GeneralSettingUpdaterBinding {
    exposedName: keyof GeneralSettingUpdaters;
    key: GeneralSettingKey;
    normalize(value: unknown): GeneralSettingValue;
}

const DEFAULT_GENERAL_SETTINGS: GeneralSettingsData = {
    ...GENERAL_SETTINGS_DEFAULTS,
    ...BROWSER_SETTINGS_DEFAULTS,
    ...SEARCH_SETTINGS_DEFAULTS,
};

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

function jsonSettingDefinitionForKey(key: string): GeneralSettingDefinition {
    const section = findJsonSettingsSection(key);
    if (!section) {
        throw new Error(`Unknown json settings section: ${key}`);
    }
    return jsonSettingDefinition(section);
}

export const JSON_GENERAL_SETTING_DEFINITIONS: readonly GeneralSettingDefinition[] = [
    ...BROWSER_JSON_SETTING_KEYS,
    ...SEARCH_JSON_SETTING_KEYS,
].map(jsonSettingDefinitionForKey);

export const GENERAL_SETTING_DEFINITIONS: readonly GeneralSettingDefinition[] = [
    ...GENERAL_SCALAR_SETTING_SPECS.map(scalarSettingDefinition),
    ...JSON_GENERAL_SETTING_DEFINITIONS,
];

export const GENERAL_SETTING_COMPUTED_BINDINGS: readonly GeneralSettingComputedBinding[] = [
    ...GENERAL_COMPUTED_BINDINGS,
    ...BROWSER_COMPUTED_BINDINGS,
    ...SEARCH_COMPUTED_BINDINGS,
];

export const GENERAL_SETTING_UPDATER_BINDINGS: readonly GeneralSettingUpdaterBinding[] = [
    ...GENERAL_UPDATER_BINDINGS,
    ...BROWSER_UPDATER_BINDINGS,
    ...SEARCH_UPDATER_BINDINGS,
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
    for (const definition of JSON_GENERAL_SETTING_DEFINITIONS) {
        const section = findJsonSettingsSection(definition.key);
        if (section) {
            assignGeneralSettingField(
                defaults,
                section.stateKey,
                cloneJsonSettingsDefault(section)
            );
        }
    }
    return defaults;
}

export function cloneGeneralSettingsSnapshot(source: GeneralSettingsData): GeneralSettingsData {
    const snapshot: GeneralSettingsData = {
        ...source,
        searchWindowDefaultSize: { ...source.searchWindowDefaultSize },
    };
    for (const definition of JSON_GENERAL_SETTING_DEFINITIONS) {
        const section = findJsonSettingsSection(definition.key);
        if (!section) {
            continue;
        }
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
