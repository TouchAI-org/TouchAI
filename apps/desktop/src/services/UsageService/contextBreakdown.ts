// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { BuiltInTool, McpTool } from '@database/schema';
import type { PromptSnapshot } from '@services/AgentService/prompt/types';

/**
 * prompt 各部分的字符数快照。
 *
 * 只存**字符数**而非 token：token 估算规则可能调整，存字符让历史数据
 * 不受算法变更影响；查询时再按 CJK 占比折算。
 */
export interface PromptBreakdownJson {
    /** 按 PromptFragmentSource 聚合的字符数 */
    fragments: Record<string, number>;
    /** 本轮用户输入 */
    userPrompt: number;
    /** 附件摘要（名称 + MIME） */
    attachments: number;
    /** 内置工具定义（名称 + 描述） */
    builtinToolDefinitions: number;
    /** MCP 工具定义（名称 + 描述 + input schema），通常是大头 */
    mcpToolDefinitions: number;
    /** 拼接后的 system prompt 总长 */
    systemPromptTotal: number;
}

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

/** CJK 字符判定：中日韩统一表意文字 + 日文假名 + 韩文音节 */
function isCjk(codePoint: number): boolean {
    return (
        (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
        (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7af)
    );
}

/**
 * 按字符数估算 token。
 *
 * - CJK：约 1 字符 = 0.67 token（chars / 1.5）
 * - 拉丁/代码：约 1 字符 = 0.25 token（chars / 4）
 *
 * ⚠️ 供应商不返回 prompt 分片，只能估。UI 上必须带 `≈`。
 * 但**总量是精确的**——`llm_call` 片段记的是供应商返回的真实 inputTokens。
 */
export function estimateTokensFromChars(chars: number, cjkRatio = 0.3): number {
    if (chars <= 0) {
        return 0;
    }
    const clamped = Math.max(0, Math.min(1, cjkRatio));
    return Math.ceil(chars * (clamped / 1.5 + (1 - clamped) / 4));
}

/**
 * 估算一段文本的 token（需要实际文本时用这个）。
 *
 * 与 `estimateTokensFromChars` 的区别：这里逐字符判定 CJK 占比，更准但更慢。
 */
export function estimateTokens(text: string): number {
    if (!text) {
        return 0;
    }
    let cjk = 0;
    let other = 0;
    for (const char of text) {
        if (isCjk(char.codePointAt(0) ?? 0)) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    return Math.ceil(cjk / 1.5 + other / 4);
}

/** 解析已入库的分片 JSON，容错返回 null */
export function parsePromptBreakdown(raw: string | null): PromptBreakdownJson | null {
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw) as Partial<PromptBreakdownJson>;
        if (!parsed || typeof parsed !== 'object' || !parsed.fragments) {
            return null;
        }
        return {
            fragments: parsed.fragments ?? {},
            userPrompt: parsed.userPrompt ?? 0,
            attachments: parsed.attachments ?? 0,
            builtinToolDefinitions: parsed.builtinToolDefinitions ?? 0,
            mcpToolDefinitions: parsed.mcpToolDefinitions ?? 0,
            systemPromptTotal: parsed.systemPromptTotal ?? 0,
        };
    } catch {
        return null;
    }
}
