// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import { z } from '../../utils/toolSchema';

export const UPGRADE_MODEL_TOOL_NAME = 'UpgradeModel';
export const upgradeModelArgsSchema = z
    .object({
        role: z.enum(['entry', 'fast', 'general']).optional(),
        scenario: z.string().trim().min(1).nullable().optional(),
        restore: z.boolean().optional(),
    })
    .strict();

/**
 * 暴露给模型的 UpgradeModel 工具说明。
 */
export const UPGRADE_MODEL_TOOL_DESCRIPTION =
    'Call immediately when the user asks to upgrade the current model, switch to a stronger model, or move to the next higher-level model with no arguments. When model routing is enabled and a task clearly matches a configured role or scenario, call with { "role": "fast" }, { "role": "general" }, or { "scenario": "<Scenario>" }. Use { "restore": true } or { "role": "entry" } to return to the default model.';

/**
 * 暴露给模型的 UpgradeModel 工具输入 schema。
 */
export const UPGRADE_MODEL_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        role: {
            type: 'string',
            enum: ['entry', 'fast', 'general'],
            description:
                'Configured model role. Use "fast" for simple tasks, "general" for complex tasks without a matching scenario, or "entry" to return to the default model.',
        },
        scenario: {
            type: ['string', 'null'],
            minLength: 1,
            pattern: '\\S',
            description:
                'Exact scenario name from the configured model preferences. Use null to restore the default model.',
        },
        restore: {
            type: 'boolean',
            description: 'Set true to switch back to the default model.',
        },
    },
    required: [],
    additionalProperties: false,
};
