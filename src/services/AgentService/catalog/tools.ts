// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelWithProvider } from '@database/queries/models';

import { builtInToolService } from '@/services/BuiltInToolService';

import type { AiToolDefinition } from '../contracts/tooling';
import { mcpManager } from '../infrastructure/mcp';

export interface ResolveToolDefinitionsOptions {
    excludedToolNames?: string[];
}

/**
 * 解析当前模型可用的工具定义列表。
 */
export async function resolveToolDefinitions(
    model: ModelWithProvider,
    options: ResolveToolDefinitionsOptions = {}
): Promise<AiToolDefinition[] | undefined> {
    if (model.tool_call !== 1) {
        return undefined;
    }

    const [mcpTools, builtInTools] = await Promise.all([
        mcpManager.getEnabledToolDefinitions(),
        builtInToolService.getEnabledToolDefinitions(),
    ]);
    const allTools = [...mcpTools, ...builtInTools];
    if (!options.excludedToolNames?.length) {
        return allTools;
    }

    const excludedToolNames = new Set(options.excludedToolNames);
    return allTools.filter((tool) => !excludedToolNames.has(tool.name));
}
