// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelWithProvider } from '@database/queries/models';

import { builtInToolService } from '@/services/BuiltInToolService';
import { TOOL_TIMEOUT_MAX_MS, TOOL_TIMEOUT_MIN_MS } from '@/utils/timeouts';

import type { AiToolDefinition } from '../contracts/tooling';
import { mcpManager } from '../infrastructure/mcp';

export interface ResolveToolDefinitionsOptions {
    excludedToolNames?: string[];
}

/**
 * 构造模型建议单次工具调用超时用的 `_meta` 参数 schema。
 *
 * 只在工具确实消费该建议（声明了 `adaptiveTimeoutCeilingMs`）时才注入，
 * 且上限取该工具自己的封顶值，避免向模型承诺一个执行层并不生效的范围。
 */
function buildAdaptiveTimeoutMetaProperty(ceilingMs: number): Record<string, unknown> {
    return {
        type: 'object',
        description: 'Optional execution metadata for this tool call.',
        properties: {
            timeoutMs: {
                type: 'integer',
                description: `Optional timeout in milliseconds. Use only when a task is expected to take longer or shorter than the default. Minimum: ${TOOL_TIMEOUT_MIN_MS} (1 second). Maximum: ${ceilingMs} milliseconds.`,
                minimum: TOOL_TIMEOUT_MIN_MS,
                maximum: ceilingMs,
            },
        },
    };
}

function withAdaptiveTimeoutSchema(tool: AiToolDefinition): AiToolDefinition {
    const { adaptiveTimeoutCeilingMs, ...definition } = tool;
    if (adaptiveTimeoutCeilingMs === undefined) {
        return definition;
    }

    return {
        ...definition,
        input_schema: {
            ...definition.input_schema,
            properties: {
                ...definition.input_schema.properties,
                _meta: buildAdaptiveTimeoutMetaProperty(
                    Math.min(adaptiveTimeoutCeilingMs, TOOL_TIMEOUT_MAX_MS)
                ),
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
    const excludedToolNames = options.excludedToolNames?.length
        ? new Set(options.excludedToolNames)
        : undefined;

    return allTools
        .filter((tool) => !excludedToolNames?.has(tool.name))
        .map(withAdaptiveTimeoutSchema);
}
