// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelWithProvider } from '@database/queries/models';

import { builtInToolService } from '@/services/BuiltInToolService';
import { TOOL_TIMEOUT_MAX_MS, TOOL_TIMEOUT_META_KEY, TOOL_TIMEOUT_MIN_MS } from '@/utils/timeouts';

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

/**
 * 返回带 `_meta` 超时参数的工具定义；不支持或发生键冲突时原样返回。
 *
 * 只有真正注入 `_meta` 的定义才会带上 `adaptiveTimeoutCeilingMs`，执行器据此
 * 判断“是否应把 `_meta` 当作超时信封剥离”。若工具自身已声明 `_meta` 业务参数
 * （属性或 required），则放弃自适应超时，避免覆盖或吞掉服务器定义的参数。
 */
function withAdaptiveTimeoutSchema(tool: AiToolDefinition): AiToolDefinition {
    const { adaptiveTimeoutCeilingMs, ...definition } = tool;
    const { properties, required } = definition.input_schema;
    const hasMetaCollision =
        TOOL_TIMEOUT_META_KEY in properties || required?.includes(TOOL_TIMEOUT_META_KEY);
    if (adaptiveTimeoutCeilingMs === undefined || hasMetaCollision) {
        return definition;
    }

    return {
        ...definition,
        adaptiveTimeoutCeilingMs: Math.min(adaptiveTimeoutCeilingMs, TOOL_TIMEOUT_MAX_MS),
        input_schema: {
            ...definition.input_schema,
            properties: {
                ...properties,
                [TOOL_TIMEOUT_META_KEY]: buildAdaptiveTimeoutMetaProperty(
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
