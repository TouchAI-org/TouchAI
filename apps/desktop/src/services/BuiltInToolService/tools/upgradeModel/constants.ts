// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/contracts/tooling';

import { z } from '../../utils/toolSchema';

export const UPGRADE_MODEL_TOOL_NAME = 'UpgradeModel';
export const upgradeModelArgsSchema = z.object({}).strict();

/**
 * 暴露给模型的 UpgradeModel 工具说明。
 */
export const UPGRADE_MODEL_TOOL_DESCRIPTION =
    'Call immediately when the user asks to upgrade the current model, switch to a stronger model, or move to the next higher-level model. No arguments are required.';

/**
 * 暴露给模型的 UpgradeModel 工具输入 schema。
 */
export const UPGRADE_MODEL_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
};
