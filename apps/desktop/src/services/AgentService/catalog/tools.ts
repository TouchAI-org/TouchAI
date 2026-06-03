// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelWithProvider } from '@database/queries/models';

import { builtInToolService } from '@/services/BuiltInToolService';

import type { AiToolDefinition } from '../contracts/tooling';
import { mcpManager } from '../infrastructure/mcp';

export interface ResolveToolDefinitionsOptions {
    excludedToolNames?: string[];
}

const TOOL_TIMEOUT_META_PROPERTY = {
    type: 'object',
    description: 'Optional execution metadata for this tool call.',
    properties: {
        timeoutMs: {
            type: 'integer',
            description:
                'Optional timeout in milliseconds. Use only when a task is expected to take longer or shorter than the default. Maximum: 600000 (10 minutes).',
        },
    },
} as const;

function withAdaptiveTimeoutSchema(tool: AiToolDefinition): AiToolDefinition {
    return {
        ...tool,
        input_schema: {
            ...tool.input_schema,
            properties: {
                ...tool.input_schema.properties,
                _meta: TOOL_TIMEOUT_META_PROPERTY,
            },
        },
    };
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
    let filteredTools = allTools;
    if (options.excludedToolNames?.length) {
        const excludedToolNames = new Set(options.excludedToolNames);
        filteredTools = allTools.filter((tool) => !excludedToolNames.has(tool.name));
    }

    return filteredTools.map(withAdaptiveTimeoutSchema);
}
