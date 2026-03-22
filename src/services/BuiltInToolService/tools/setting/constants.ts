// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AiService/types';

import {
    arrayFromScalarSchema,
    integerInRangeSchema,
    nonEmptyTrimmedStringSchema,
    z,
} from '../../utils/toolSchema';

export const SETTING_TOOL_ACTIONS = ['list', 'get', 'set'] as const;
export const SUPPORTED_SETTING_KEYS = [
    'global_shortcut',
    'start_on_boot',
    'start_minimized',
    'mcp_max_iterations',
    'output_scroll_behavior',
] as const;
export const OUTPUT_SCROLL_BEHAVIORS = ['follow_output', 'stay_position', 'jump_to_top'] as const;
export const TOOL_KEY_TO_STORE_KEY = {
    global_shortcut: 'globalShortcut',
    start_on_boot: 'startOnBoot',
    start_minimized: 'startMinimized',
    mcp_max_iterations: 'mcpMaxIterations',
    output_scroll_behavior: 'outputScrollBehavior',
} as const;

export type SettingToolAction = (typeof SETTING_TOOL_ACTIONS)[number];
export type SupportedSettingKey = (typeof SUPPORTED_SETTING_KEYS)[number];
export type SupportedSettingValue = string | number | boolean;
export type StoreSettingKey = (typeof TOOL_KEY_TO_STORE_KEY)[SupportedSettingKey];

export interface SettingToolItem {
    key: SupportedSettingKey;
    title: string;
    description: string;
    kind: 'string' | 'boolean' | 'number' | 'enum' | 'list';
    value: SupportedSettingValue;
    allowedValues?: string[];
    minimum?: number;
    maximum?: number;
    sideEffect?: string;
}

interface SettingDefinition {
    key: SupportedSettingKey;
    label: string;
    description: string;
    type: 'string' | 'boolean' | 'number' | 'enum' | 'list';
    allowedValues?: readonly string[];
    examples: string[];
    minimum?: number;
    maximum?: number;
    sideEffect?: string;
}

export const SETTING_TOOL_NAME = 'Setting';

export const SETTING_DEFINITIONS: Record<SupportedSettingKey, SettingDefinition> = {
    global_shortcut: {
        key: 'global_shortcut',
        label: '全局快捷键',
        description: '用于呼出主搜索窗口的全局快捷键。',
        type: 'string',
        examples: ['Alt+Space', 'Ctrl+Shift+Space'],
        sideEffect: '修改时会立即尝试重新注册全局快捷键。',
    },
    start_on_boot: {
        key: 'start_on_boot',
        label: '开机自启动',
        description: '控制 TouchAI 是否在系统启动时自动启动。',
        type: 'boolean',
        examples: ['true', 'false'],
        sideEffect: '修改时会立即调用系统自启动能力。',
    },
    start_minimized: {
        key: 'start_minimized',
        label: '启动时最小化',
        description: '控制 TouchAI 是否在启动后默认隐藏到系统托盘。',
        type: 'boolean',
        examples: ['true', 'false'],
    },
    mcp_max_iterations: {
        key: 'mcp_max_iterations',
        label: '最大工具调用轮数',
        description: '控制一次请求里允许的最大 MCP / 内置工具连续调用轮数。',
        type: 'number',
        examples: ['8', '12'],
        minimum: 1,
        maximum: 50,
    },
    output_scroll_behavior: {
        key: 'output_scroll_behavior',
        label: '输出滚动策略',
        description: '控制对话输出流式更新时的滚动行为。',
        type: 'enum',
        allowedValues: OUTPUT_SCROLL_BEHAVIORS,
        examples: [...OUTPUT_SCROLL_BEHAVIORS],
    },
};

export const outputScrollBehaviorSchema = z.enum(OUTPUT_SCROLL_BEHAVIORS);
const supportedSettingKeySchema = z.enum(SUPPORTED_SETTING_KEYS);
const rawSettingValueSchema = z.union([z.string(), z.boolean(), z.number()]);

export const settingArgsSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('list'),
    }),
    z.object({
        action: z.literal('get'),
        keys: arrayFromScalarSchema(supportedSettingKeySchema),
    }),
    z.object({
        action: z.literal('set'),
        key: supportedSettingKeySchema,
        value: rawSettingValueSchema,
        reason: nonEmptyTrimmedStringSchema,
    }),
]);
export const settingValueSchemaByKey = {
    global_shortcut: nonEmptyTrimmedStringSchema,
    start_on_boot: z.boolean(),
    start_minimized: z.boolean(),
    mcp_max_iterations: integerInRangeSchema(1, 50),
    output_scroll_behavior: outputScrollBehaviorSchema,
};

/**
 * 暴露给模型的 Setting 工具说明。
 */
export const SETTING_TOOL_DESCRIPTION = '读取和修改应用设置';

function withExamples(description: string, ...examples: string[]): string {
    return `${description} Examples: ${examples.join(' | ')}.`;
}

/**
 * 暴露给模型的 Setting 工具输入 schema。
 */
export const SETTING_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        action: {
            type: 'string',
            enum: [...SETTING_TOOL_ACTIONS],
            description: withExamples(
                'Required action. Use list to inspect supported settings, get to read current values, set to update values.',
                '"list"',
                '"set"'
            ),
        },
        keys: {
            type: 'array',
            items: { type: 'string', enum: [...SUPPORTED_SETTING_KEYS] },
            description: withExamples(
                'Optional keys for get action. Omit to read all supported settings.',
                '["mcp_max_iterations","output_scroll_behavior"]',
                '["global_shortcut"]'
            ),
        },
        key: {
            type: 'string',
            enum: [...SUPPORTED_SETTING_KEYS],
            description: withExamples(
                'Required for set action. The single setting key to update.',
                '"start_on_boot"',
                '"global_shortcut"'
            ),
        },
        value: {
            anyOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'integer' }],
            description: withExamples(
                'Required for set action. The new value for the single setting key.',
                'true',
                '"Ctrl+Shift+Space"',
                '12'
            ),
        },
        reason: {
            type: 'string',
            description: withExamples(
                'Required for set action. User-facing explanation shown in the approval UI.',
                '"The user asked me to reduce the agent loop limit to 8 for faster responses."',
                '"The user wants TouchAI to launch at boot and stay minimized."'
            ),
        },
    },
    required: ['action'],
};
