// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { BuiltInTool, McpTool } from '@database/schema';
import type { PromptSnapshot } from '@services/AgentService/prompt/types';
import type { PromptBreakdownJson } from '@utils/promptBreakdown';

export type { PromptBreakdownJson } from '@utils/promptBreakdown';
export {
    estimateTokens,
    estimateTokensFromChars,
    parsePromptBreakdown,
    sumFragmentChars,
} from '@utils/promptBreakdown';

/**
 * 从 prompt 快照拆解各部分的字符数。
 *
 * TouchAI 的 prompt 是结构化装配的（`fragments[]` 带 `source` 标签），
 * 因此能精确知道每段属于哪一类，不需要像 magpie 那样从 HTTP body 反解。
 */
export function buildPromptBreakdown(
    snapshot: PromptSnapshot,
    mcpTools: readonly McpTool[],
    builtInTools: readonly BuiltInTool[]
): PromptBreakdownJson {
    const fragments: Record<string, number> = {};
    for (const fragment of snapshot.fragments) {
        fragments[fragment.source] = (fragments[fragment.source] ?? 0) + fragment.content.length;
    }

    return {
        fragments,
        userPrompt: snapshot.userPrompt.length,
        attachments: snapshot.attachments.reduce(
            (sum, item) => sum + item.name.length + (item.mimeType?.length ?? 0),
            0
        ),
        builtinToolDefinitions: builtInTools.reduce(
            (sum, tool) => sum + tool.tool_id.length + (tool.description?.length ?? 0),
            0
        ),
        mcpToolDefinitions: mcpTools.reduce(
            (sum, tool) =>
                sum + tool.name.length + (tool.description?.length ?? 0) + tool.input_schema.length,
            0
        ),
        systemPromptTotal: snapshot.systemPrompt.length,
    };
}
