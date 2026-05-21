// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import { z } from '../../utils/toolSchema';

export const UPGRADE_MODEL_TOOL_NAME = 'UpgradeModel';
export const upgradeModelArgsSchema = z.object({}).strict();

/**
 * 暴露给模型的 UpgradeModel 工具说明。
 */
export const UPGRADE_MODEL_TOOL_DESCRIPTION =
    '当用户要求升级当前模型、切换到更强模型或切到更高一级模型时立即调用；无需参数';

/**
 * 暴露给模型的 UpgradeModel 工具输入 schema。
 */
export const UPGRADE_MODEL_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
};
