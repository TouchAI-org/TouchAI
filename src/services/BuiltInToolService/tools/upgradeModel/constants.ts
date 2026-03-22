// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AiService/types';

import { z } from '../../utils/toolSchema';

export const UPGRADE_MODEL_TOOL_NAME = 'UpgradeModel';
export const upgradeModelArgsSchema = z.object({}).strict();

/**
 * 暴露给模型的 UpgradeModel 工具说明。
 */
export const UPGRADE_MODEL_TOOL_DESCRIPTION = '升级当前请求模型';

/**
 * 暴露给模型的 UpgradeModel 工具输入 schema。
 */
export const UPGRADE_MODEL_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
};
