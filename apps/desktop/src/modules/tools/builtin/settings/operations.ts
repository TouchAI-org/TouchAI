// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { ToolMessages } from '../../contracts/host';
import { parseToolArguments } from '../../execution/schema';
import {
    SETTING_DEFINITIONS,
    SETTING_TOOL_NAME,
    settingArgsSchema,
    type SettingToolItem,
    settingValueSchemaByKey,
    SUPPORTED_SETTING_KEYS,
    type SupportedSettingKey,
    type SupportedSettingValue,
} from './constants';
import type { ToolSettingsCapabilities } from './host';

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

export function createSettingOperations(messages: ToolMessages) {
    const { t, tt } = messages;
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
    function parseSettingRequest(args: Record<string, unknown>): ParsedSettingRequest {
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
                    keys:
                        parsedArgs.keys.length > 0 ? parsedArgs.keys : [...SUPPORTED_SETTING_KEYS],
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

    async function buildSettingItem(
        settingsService: ToolSettingsCapabilities,
        key: SupportedSettingKey
    ): Promise<SettingToolItem> {
        const definition = SETTING_DEFINITIONS[key];
        const value = (await settingsService.read(key)) as SupportedSettingValue;

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

    async function listSupportedSettings(
        settingsService: ToolSettingsCapabilities
    ): Promise<string> {
        const items = await Promise.all(
            Object.keys(SETTING_DEFINITIONS).map((key) =>
                buildSettingItem(settingsService, key as SupportedSettingKey)
            )
        );
        const lines = items.map((item, index) => formatSettingMetadata(item, index));

        return [tt('可用设置'), ...lines].join('\n\n');
    }

    async function getSettings(
        settingsService: ToolSettingsCapabilities,
        keys: SupportedSettingKey[]
    ): Promise<string> {
        const items = await Promise.all(keys.map((key) => buildSettingItem(settingsService, key)));
        const lines = items.map(
            (item, index) => `${index + 1}. ${formatSettingSummary(item.key, item.value)}`
        );

        return [tt('当前设置值'), ...lines].join('\n');
    }

    function formatSingleUpdate(key: SupportedSettingKey, value: SupportedSettingValue): string {
        return `1. ${formatSettingSummary(key, value)}`;
    }

    function formatSettingValue(value: SupportedSettingValue): string {
        return typeof value === 'string' ? value : String(value);
    }

    return {
        parseSettingRequest,
        formatSingleUpdate,
        listSupportedSettings,
        getSettings,
        formatSettingValue,
    };
}
