import { computed, type ComputedRef, type Ref } from 'vue';

import type { AppUpdateChannel } from '@/config/appUpdate';
import type { SearchWindowDefaultSize, SearchWindowSizePreset } from '@/config/searchWindow';
import type { AppLocale } from '@/i18n';
import type { BrowserSettingsConfig } from '@/stores/setting/sections/browser';
import {
    cloneJsonSettingsDefault,
    JSON_SETTINGS_SECTIONS,
    type JsonSettingsKey,
    parseJsonSettingsValue,
    type RegisteredJsonSettingsSection,
    type RegisteredJsonSettingsValue,
    serializeJsonSettingsValue,
} from '@/stores/setting/sections/registry';
import type { SearchSettingsConfig } from '@/stores/setting/sections/search';

import {
    GENERAL_DERIVED_COMPUTED_BINDINGS,
    GENERAL_SCALAR_SETTING_SPECS,
    GENERAL_SETTINGS_DEFAULTS,
    type GeneralScalarSettingKey,
} from './general';

export type OutputScrollBehavior = 'follow_output' | 'stay_position' | 'jump_to_top';
export type GeneralSettingKey = GeneralScalarSettingKey | JsonSettingsKey;
export type GeneralSettingValue = string | number | boolean | null;

export interface GeneralSettingsData {
    globalShortcut: string;
    startOnBoot: boolean;
    startMinimized: boolean;
    allowModelAutoSwitch: boolean;
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

type GeneralScalarSettingStateKey = Exclude<
    keyof GeneralSettingsData,
    'browserSettings' | 'searchSettings' | 'searchWindowDefaultSize'
>;
type GeneralPersistedSettingStateKey = Exclude<
    keyof GeneralSettingsData,
    'searchWindowDefaultSize'
>;

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
    updateAllowModelAutoSwitch(enabled: boolean): Promise<void>;
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
    key: string;
    stateKey: GeneralScalarSettingStateKey;
    defaultValue: GeneralSettingFieldValue;
    parsePersisted(raw: string | null): GeneralSettingFieldValue;
    parseUpdate(value: GeneralSettingValue): GeneralSettingFieldValue;
    serializeValue?(value: GeneralSettingFieldValue): string;
    eventValue?(value: GeneralSettingFieldValue): GeneralSettingValue;
    afterApply?(target: GeneralSettingsData, value: GeneralSettingFieldValue): void;
    persistBeforeApply?: boolean;
    store?: {
        computedName?: keyof GeneralSettingsComputedRefs;
        updaterName?: keyof GeneralSettingUpdaters;
        normalizeUpdate?: (value: unknown) => GeneralSettingValue;
    };
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
} as GeneralSettingsData;

function assignGeneralSettingField(
    target: GeneralSettingsData,
    stateKey: GeneralPersistedSettingStateKey,
    value: GeneralSettingFieldValue
): void {
    (target as unknown as Record<GeneralPersistedSettingStateKey, GeneralSettingFieldValue>)[
        stateKey
    ] = value;
}

function readGeneralSettingField(
    source: GeneralSettingsData,
    stateKey: GeneralPersistedSettingStateKey
): GeneralSettingFieldValue {
    return (source as unknown as Record<GeneralPersistedSettingStateKey, GeneralSettingFieldValue>)[
        stateKey
    ];
}

type RegisteredScalarSettingSpec = ScalarSettingDefinitionOptions & {
    key: GeneralScalarSettingKey;
};

function scalarSettingDefinition(options: RegisteredScalarSettingSpec): GeneralSettingDefinition {
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

function jsonComputedBinding(
    section: RegisteredJsonSettingsSection
): GeneralSettingComputedBinding {
    return {
        exposedName: section.store.computedName,
        stateKey: section.stateKey,
    };
}

function jsonUpdaterBinding(section: RegisteredJsonSettingsSection): GeneralSettingUpdaterBinding {
    return {
        exposedName: section.store.updaterName,
        key: section.key,
        normalize: (value) =>
            serializeJsonSettingsValue(section, value as RegisteredJsonSettingsValue),
    };
}

function scalarComputedBindings(
    specs: readonly RegisteredScalarSettingSpec[]
): GeneralSettingComputedBinding[] {
    return specs.flatMap((spec) =>
        spec.store?.computedName
            ? [
                  {
                      exposedName: spec.store.computedName,
                      stateKey: spec.stateKey,
                  },
              ]
            : []
    );
}

function scalarUpdaterBindings(
    specs: readonly RegisteredScalarSettingSpec[]
): GeneralSettingUpdaterBinding[] {
    return specs.flatMap((spec) =>
        spec.store?.updaterName
            ? [
                  {
                      exposedName: spec.store.updaterName,
                      key: spec.key,
                      normalize: spec.store.normalizeUpdate ?? String,
                  },
              ]
            : []
    );
}

export const JSON_GENERAL_SETTING_DEFINITIONS: readonly GeneralSettingDefinition[] =
    JSON_SETTINGS_SECTIONS.map(jsonSettingDefinition);

export const GENERAL_SETTING_DEFINITIONS: readonly GeneralSettingDefinition[] = [
    ...GENERAL_SCALAR_SETTING_SPECS.map(scalarSettingDefinition),
    ...JSON_GENERAL_SETTING_DEFINITIONS,
];

export const GENERAL_SETTING_COMPUTED_BINDINGS: readonly GeneralSettingComputedBinding[] = [
    ...scalarComputedBindings(GENERAL_SCALAR_SETTING_SPECS),
    ...GENERAL_DERIVED_COMPUTED_BINDINGS,
    ...JSON_SETTINGS_SECTIONS.map(jsonComputedBinding),
];

export const GENERAL_SETTING_UPDATER_BINDINGS: readonly GeneralSettingUpdaterBinding[] = [
    ...scalarUpdaterBindings(GENERAL_SCALAR_SETTING_SPECS),
    ...JSON_SETTINGS_SECTIONS.map(jsonUpdaterBinding),
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
