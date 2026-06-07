// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { getSettingValue, setSetting } from '@database/queries';
import { AppEvent, eventService, type GeneralSettingKey } from '@services/EventService';
import { native } from '@services/NativeService';

import {
    DEFAULT_SEARCH_WINDOW_SIZE_PRESET,
    resolveSearchWindowDefaultSize,
    type SearchWindowDefaultSize,
    type SearchWindowSizePreset,
} from '@/config/searchWindow';
import {
    type AppLocale,
    normalizeLocale,
    resolveFirstLaunchLocale,
    setLocale,
    t,
    tt,
} from '@/i18n';

import { parseToolArguments } from '../../utils/toolSchema';
import {
    SETTING_DEFINITIONS,
    SETTING_TOOL_NAME,
    settingArgsSchema,
    type SettingToolItem,
    settingValueSchemaByKey,
    type StoreSettingKey,
    SUPPORTED_SETTING_KEYS,
    type SupportedSettingKey,
    type SupportedSettingValue,
    TOOL_KEY_TO_STORE_KEY,
} from './constants';

export type OutputScrollBehavior = 'follow_output' | 'stay_position' | 'jump_to_top';

export interface GeneralSettingsData {
    globalShortcut: string;
    startOnBoot: boolean;
    startMinimized: boolean;
    outputScrollBehavior: OutputScrollBehavior;
    searchWindowSizePreset: SearchWindowSizePreset;
    searchWindowDefaultSize: SearchWindowDefaultSize;
    language: AppLocale;
}

export type ParsedSettingRequest =
    | {
          action: 'list';
          keys: SupportedSettingKey[];
      }
    | {
          action: 'get';
          keys: SupportedSettingKey[];
      }
    | {
          action: 'set';
          keys: SupportedSettingKey[];
          key: SupportedSettingKey;
          value: SupportedSettingValue;
          reason: string;
      };

export type SettingsStore = Awaited<ReturnType<typeof prepareSettingsStore>>;

const DEFAULT_GENERAL_SETTINGS: GeneralSettingsData = {
    globalShortcut: 'Alt+Space',
    startOnBoot: false,
    startMinimized: true,
    outputScrollBehavior: 'follow_output',
    searchWindowSizePreset: DEFAULT_SEARCH_WINDOW_SIZE_PRESET,
    searchWindowDefaultSize: resolveSearchWindowDefaultSize(DEFAULT_SEARCH_WINDOW_SIZE_PRESET),
    language: 'zh-CN',
};

const outputScrollBehaviorValues = ['follow_output', 'stay_position', 'jump_to_top'] as const;

function createDefaultGeneralSettings(): GeneralSettingsData {
    return {
        ...DEFAULT_GENERAL_SETTINGS,
        searchWindowDefaultSize: {
            ...DEFAULT_GENERAL_SETTINGS.searchWindowDefaultSize,
        },
    };
}

function normalizeOutputScrollBehavior(value: string | null): OutputScrollBehavior {
    return outputScrollBehaviorValues.includes(value as OutputScrollBehavior)
        ? (value as OutputScrollBehavior)
        : DEFAULT_GENERAL_SETTINGS.outputScrollBehavior;
}

function normalizeSearchWindowSizePreset(value: unknown): SearchWindowSizePreset {
    const result = settingValueSchemaByKey.search_window_size_preset.safeParse(value);
    return result.success ? result.data : DEFAULT_GENERAL_SETTINGS.searchWindowSizePreset;
}

function resolvePersistedLanguage(language: string | null): AppLocale {
    if (language === null) {
        return resolveFirstLaunchLocale();
    }

    return normalizeLocale(language);
}

function applySearchWindowSizePreset(
    settings: GeneralSettingsData,
    preset: SearchWindowSizePreset
): void {
    settings.searchWindowSizePreset = preset;
    settings.searchWindowDefaultSize = {
        ...resolveSearchWindowDefaultSize(preset),
    };
}

function serializeSetting(settings: GeneralSettingsData, key: GeneralSettingKey): string {
    switch (key) {
        case 'global_shortcut':
            return settings.globalShortcut;
        case 'start_on_boot':
            return String(settings.startOnBoot);
        case 'start_minimized':
            return String(settings.startMinimized);
        case 'output_scroll_behavior':
            return settings.outputScrollBehavior;
        case 'search_window_size_preset':
            return settings.searchWindowSizePreset;
        case 'language':
            return settings.language;
        default:
            return '';
    }
}

function payloadValueForEvent(settings: GeneralSettingsData, key: GeneralSettingKey) {
    switch (key) {
        case 'global_shortcut':
            return settings.globalShortcut;
        case 'start_on_boot':
            return settings.startOnBoot;
        case 'start_minimized':
            return settings.startMinimized;
        case 'output_scroll_behavior':
            return settings.outputScrollBehavior;
        case 'search_window_size_preset':
            return settings.searchWindowSizePreset;
        case 'language':
            return settings.language;
        default:
            return '';
    }
}

async function persistDefaultIfMissing(
    settings: GeneralSettingsData,
    key: GeneralSettingKey,
    currentValue: string | null
): Promise<void> {
    if (currentValue !== null) {
        return;
    }

    await setSetting({ key, value: serializeSetting(settings, key) });
}

async function loadGeneralSettings(): Promise<GeneralSettingsData> {
    const settings = createDefaultGeneralSettings();
    const [
        globalShortcut,
        startOnBoot,
        startMinimized,
        outputScroll,
        searchWindowSizePreset,
        language,
    ] = await Promise.all([
        getSettingValue({ key: 'global_shortcut' }),
        getSettingValue({ key: 'start_on_boot' }),
        getSettingValue({ key: 'start_minimized' }),
        getSettingValue({ key: 'output_scroll_behavior' }),
        getSettingValue({ key: 'search_window_size_preset' }),
        getSettingValue({ key: 'language' }),
    ]);

    settings.globalShortcut = globalShortcut || DEFAULT_GENERAL_SETTINGS.globalShortcut;
    settings.startOnBoot =
        startOnBoot === null ? DEFAULT_GENERAL_SETTINGS.startOnBoot : startOnBoot === 'true';
    settings.startMinimized =
        startMinimized === null
            ? DEFAULT_GENERAL_SETTINGS.startMinimized
            : startMinimized === 'true';
    settings.outputScrollBehavior = normalizeOutputScrollBehavior(outputScroll);
    applySearchWindowSizePreset(settings, normalizeSearchWindowSizePreset(searchWindowSizePreset));
    settings.language = resolvePersistedLanguage(language);
    setLocale(settings.language);

    await Promise.allSettled([
        persistDefaultIfMissing(settings, 'global_shortcut', globalShortcut),
        persistDefaultIfMissing(settings, 'start_on_boot', startOnBoot),
        persistDefaultIfMissing(settings, 'start_minimized', startMinimized),
        persistDefaultIfMissing(settings, 'output_scroll_behavior', outputScroll),
        persistDefaultIfMissing(settings, 'search_window_size_preset', searchWindowSizePreset),
        persistDefaultIfMissing(settings, 'language', language),
    ]);

    return settings;
}

function applySetting(
    settings: GeneralSettingsData,
    key: SupportedSettingKey,
    value: unknown
): void {
    switch (key) {
        case 'global_shortcut':
            settings.globalShortcut = String(value || DEFAULT_GENERAL_SETTINGS.globalShortcut);
            break;
        case 'start_on_boot':
            settings.startOnBoot = typeof value === 'boolean' ? value : String(value) === 'true';
            break;
        case 'start_minimized':
            settings.startMinimized = typeof value === 'boolean' ? value : String(value) === 'true';
            break;
        case 'output_scroll_behavior':
            settings.outputScrollBehavior = normalizeOutputScrollBehavior(String(value));
            break;
        case 'search_window_size_preset':
            applySearchWindowSizePreset(settings, normalizeSearchWindowSizePreset(value));
            break;
        case 'language':
            settings.language = normalizeLocale(value);
            setLocale(settings.language);
            break;
    }
}

async function updateSettingValue(
    settings: GeneralSettingsData,
    key: SupportedSettingKey,
    value: SupportedSettingValue
): Promise<void> {
    applySetting(settings, key, value);
    await setSetting({ key, value: serializeSetting(settings, key) });
    await eventService.emit(AppEvent.SETTINGS_GENERAL_UPDATED, {
        sourceId: 'built-in-setting-tool',
        windowLabel: 'agent',
        key,
        value: payloadValueForEvent(settings, key),
    });
}

function normalizeUpdateValue(key: SupportedSettingKey, value: unknown): SupportedSettingValue {
    const result = settingValueSchemaByKey[key].safeParse(value);
    if (!result.success) {
        throw new Error(
            `${t('builtInTools.setting.error.invalidValue', { key })}\n${result.error.issues
                .map((issue) => `- ${issue.message}`)
                .join('\n')}`
        );
    }

    return result.data;
}

/**
 * 把模型传入的 Setting 参数折叠成统一请求对象。
 *
 * @param args 工具参数。
 * @returns 标准化后的设置读取/写入请求。
 */
export function parseSettingRequest(args: Record<string, unknown>): ParsedSettingRequest {
    const parsedArgs = parseToolArguments(SETTING_TOOL_NAME, settingArgsSchema, args);

    switch (parsedArgs.action) {
        case 'list':
            return {
                action: 'list',
                keys: [],
            };
        case 'get':
            return {
                action: 'get',
                keys: parsedArgs.keys.length > 0 ? parsedArgs.keys : [...SUPPORTED_SETTING_KEYS],
            };
        case 'set':
            return {
                action: 'set',
                keys: [],
                key: parsedArgs.key,
                value: normalizeUpdateValue(parsedArgs.key, parsedArgs.value),
                reason: parsedArgs.reason,
            };
    }
}

export async function prepareSettingsStore() {
    const settings = await loadGeneralSettings();

    return {
        settings,
        updateGlobalShortcut: (value: GeneralSettingsData['globalShortcut']) =>
            updateSettingValue(settings, 'global_shortcut', value),
        updateStartOnBoot: (value: GeneralSettingsData['startOnBoot']) =>
            updateSettingValue(settings, 'start_on_boot', value),
        updateStartMinimized: (value: GeneralSettingsData['startMinimized']) =>
            updateSettingValue(settings, 'start_minimized', value),
        updateOutputScrollBehavior: (value: GeneralSettingsData['outputScrollBehavior']) =>
            updateSettingValue(settings, 'output_scroll_behavior', value),
        updateSearchWindowSizePreset: (value: GeneralSettingsData['searchWindowSizePreset']) =>
            updateSettingValue(settings, 'search_window_size_preset', value),
        updateLanguage: (value: GeneralSettingsData['language']) =>
            updateSettingValue(settings, 'language', value),
    };
}

function toStoreSettingKey(key: SupportedSettingKey): StoreSettingKey {
    return TOOL_KEY_TO_STORE_KEY[key];
}

function readSettingValueFromStoreState(
    settingsStore: SettingsStore,
    key: SupportedSettingKey
): SupportedSettingValue {
    const storeKey = toStoreSettingKey(key);
    return settingsStore.settings[storeKey] as GeneralSettingsData[typeof storeKey];
}

export async function readCurrentSettingValue(
    settingsStore: SettingsStore,
    key: SupportedSettingKey
): Promise<SupportedSettingValue> {
    if (key === 'start_on_boot') {
        try {
            return await native.autostart.isAutostartEnabled();
        } catch {
            return readSettingValueFromStoreState(settingsStore, key);
        }
    }

    return readSettingValueFromStoreState(settingsStore, key);
}

export function formatSettingValue(value: SupportedSettingValue): string {
    return typeof value === 'string' ? value : String(value);
}

async function buildSettingItem(
    settingsStore: SettingsStore,
    key: SupportedSettingKey
): Promise<SettingToolItem> {
    const definition = SETTING_DEFINITIONS[key];
    const value = await readCurrentSettingValue(settingsStore, key);

    return {
        key,
        title: definition.label,
        description: definition.description,
        kind: definition.type,
        value,
        allowedValues: definition.allowedValues ? [...definition.allowedValues] : undefined,
        minimum: definition.minimum,
        maximum: definition.maximum,
        sideEffect: definition.sideEffect,
    };
}

function formatSettingSummary(key: SupportedSettingKey, value: SupportedSettingValue): string {
    return `${tt(SETTING_DEFINITIONS[key].label)} (${key}): ${formatSettingValue(value)}`;
}

function formatSettingMetadata(item: SettingToolItem, index: number): string {
    const definition = SETTING_DEFINITIONS[item.key];
    const allowedValues =
        item.allowedValues && item.allowedValues.length > 0
            ? `\n   ${tt('可选值')}: ${item.allowedValues.join(', ')}`
            : '';

    return [
        `${index + 1}. ${tt(definition.label)} (${item.key})`,
        `   ${tt('当前值')}: ${formatSettingValue(item.value)}`,
        `   ${tt('类型')}: ${item.kind}`,
        `   ${tt('说明')}: ${tt(definition.description)}`,
        allowedValues,
        `   ${tt('示例')}: ${definition.examples.join(' | ')}`,
        item.sideEffect ? `   ${tt('副作用')}: ${tt(item.sideEffect)}` : '',
    ]
        .join('\n')
        .trimEnd();
}

export async function listSupportedSettings(settingsStore: SettingsStore): Promise<string> {
    const items = await Promise.all(
        Object.keys(SETTING_DEFINITIONS).map((key) =>
            buildSettingItem(settingsStore, key as SupportedSettingKey)
        )
    );
    const lines = items.map((item, index) => formatSettingMetadata(item, index));

    return [tt('可用设置'), ...lines].join('\n\n');
}

export async function getSettings(
    settingsStore: SettingsStore,
    keys: SupportedSettingKey[]
): Promise<string> {
    const items = await Promise.all(keys.map((key) => buildSettingItem(settingsStore, key)));
    const lines = items.map(
        (item, index) => `${index + 1}. ${formatSettingSummary(item.key, item.value)}`
    );

    return [tt('当前设置值'), ...lines].join('\n');
}

export function formatSingleUpdate(key: SupportedSettingKey, value: SupportedSettingValue): string {
    return `1. ${formatSettingSummary(key, value)}`;
}

export function formatShortcutRegistrationError(shortcut: string, error: unknown): string {
    const errorText = String(error);
    if (errorText.includes('already registered') || errorText.includes('已注册')) {
        return tt('快捷键 {shortcut} 已被其他应用占用。', { shortcut });
    }
    if (errorText.includes('invalid') || errorText.includes('无效')) {
        return tt('快捷键 {shortcut} 格式无效。', { shortcut });
    }
    if (errorText.includes('Unknown key')) {
        return tt('快捷键包含不支持的按键。');
    }
    return tt('注册快捷键失败：{error}', { error: errorText });
}
