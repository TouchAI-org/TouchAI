// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import { type GeneralSettingsData, useSettingsStore } from '@/stores/settings';

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

function normalizeUpdateValue(key: SupportedSettingKey, value: unknown): SupportedSettingValue {
    const result = settingValueSchemaByKey[key].safeParse(value);
    if (!result.success) {
        throw new Error(
            `Setting tool received an invalid value for "${key}".\n${result.error.issues
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
    const settingsStore = useSettingsStore();
    await settingsStore.initialize();
    return settingsStore;
}

function toStoreSettingKey(key: SupportedSettingKey): StoreSettingKey {
    return TOOL_KEY_TO_STORE_KEY[key];
}

function readSettingValueFromStoreState(
    settingsStore: ReturnType<typeof useSettingsStore>,
    key: SupportedSettingKey
): SupportedSettingValue {
    const storeKey = toStoreSettingKey(key);
    return settingsStore.settings[storeKey] as GeneralSettingsData[typeof storeKey];
}

export async function readCurrentSettingValue(
    settingsStore: ReturnType<typeof useSettingsStore>,
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
    return `${SETTING_DEFINITIONS[key].label} (${key}): ${formatSettingValue(value)}`;
}

function formatSettingMetadata(item: SettingToolItem, index: number): string {
    const definition = SETTING_DEFINITIONS[item.key];
    const allowedValues =
        item.allowedValues && item.allowedValues.length > 0
            ? `\n   可选值: ${item.allowedValues.join(', ')}`
            : '';

    return [
        `${index + 1}. ${definition.label} (${item.key})`,
        `   当前值: ${formatSettingValue(item.value)}`,
        `   类型: ${item.kind}`,
        `   说明: ${item.description}`,
        allowedValues,
        `   示例: ${definition.examples.join(' | ')}`,
        item.sideEffect ? `   副作用: ${item.sideEffect}` : '',
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

    return ['可用设置', ...lines].join('\n\n');
}

export async function getSettings(
    settingsStore: SettingsStore,
    keys: SupportedSettingKey[]
): Promise<string> {
    const items = await Promise.all(keys.map((key) => buildSettingItem(settingsStore, key)));
    const lines = items.map(
        (item, index) => `${index + 1}. ${formatSettingSummary(item.key, item.value)}`
    );

    return ['当前设置值', ...lines].join('\n');
}

export function formatSingleUpdate(key: SupportedSettingKey, value: SupportedSettingValue): string {
    return `1. ${formatSettingSummary(key, value)}`;
}

export function formatShortcutRegistrationError(shortcut: string, error: unknown): string {
    const errorText = String(error);
    if (errorText.includes('already registered') || errorText.includes('已注册')) {
        return `快捷键 ${shortcut} 已被其他应用占用。`;
    }
    if (errorText.includes('invalid') || errorText.includes('无效')) {
        return `快捷键 ${shortcut} 格式无效。`;
    }
    if (errorText.includes('Unknown key')) {
        return '快捷键包含不支持的按键。';
    }
    return `注册快捷键失败：${errorText}`;
}
