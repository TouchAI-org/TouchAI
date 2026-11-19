// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ReasoningOption, SelectableReasoningLevel } from './reasoning';

export type MediaTransportMode =
    | 'inline-image'
    | 'inline-text'
    | 'inline-base64'
    | 'provider-file-ref'
    | 'external-url';
export type MediaKind = 'image' | 'pdf' | 'text' | 'binary';
export type MediaMessagePositionMode = 'inline' | 'synthetic-user-hoist';

export interface MediaTransportDecision {
    kind: MediaKind;
    transportMode: MediaTransportMode;
    reason: string;
    shouldUpload: boolean;
    canReuseRemoteRef: boolean;
    messagePositionMode: MediaMessagePositionMode;
}

/** Protocol observations only; the host owns provenance and durable records. */
export interface MediaTransportObservation {
    messageIndex: number;
    partIndex: number;
    sourceRole: 'user' | 'tool';
    resolvedRole: 'user' | 'tool';
    messageContext: 'user' | 'tool-result';
    transportMode: MediaTransportMode;
    messagePositionMode: MediaMessagePositionMode;
    transportReason: string;
    remoteRefStrategy: string | null;
}

interface MediaInput {
    name: string;
    size: number | null;
    mimeType: string;
    /** Opaque key understood only by this connection's host cache. */
    resourceKey?: string;
    /** Semantic text is assembled by the consumer, never from a local path. */
    anchorText?: string;
    fallbackText?: string;
    toolFallbackText?: string;
}

export type AiContentPart =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string; providerOptions?: Record<string, JsonObject> }
    | (MediaInput & { type: 'image'; kind: 'image'; data: string })
    | (MediaInput & {
          type: 'file';
          kind: Exclude<MediaKind, 'image'>;
          textContent?: string;
          base64Data?: string;
      })
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/**
 * 提供给各家 provider 适配器的统一消息结构。
 */
export interface AiMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string | AiContentPart[];
    // 助手消息调用工具时：
    tool_calls?: AiToolCall[];
    // 工具结果消息：
    tool_call_id?: string;
    name?: string;
    isError?: boolean;
}

/**
 * 单次模型请求的标准化输入。
 */
export interface AiRequestOptions {
    model: string;
    messages: AiMessage[];
    /** Opaque conversation routing hint; never contains prompt content. */
    promptCacheKey?: string;
    /** Total output budget, including reasoning. */
    maxOutputTokens?: number;
    toolChoice?: 'auto' | 'none';
    supportsReasoning?: boolean;
    reasoningLevel?: SelectableReasoningLevel;
    /** 上游 /models 或本地 metadata 声明的 reasoning 能力。 */
    reasoningOptions?: ReasoningOption[];
    stream?: boolean;
    signal?: AbortSignal;
    tools?: AiToolDefinition[];
    onTransportResolved?: (
        observations: readonly MediaTransportObservation[]
    ) => Promise<void> | void;
}

export interface AiStreamChunk {
    content: string;
    reasoning?: string;
    /** 保留 provider 的思考边界，避免用整个消息的流式状态推断。 */
    reasoningState?: 'start' | 'end';
    /**
     * reasoning 片段的 provider 元数据（例如 OpenAI Responses 的 itemId 与
     * encrypted_content）。回放多轮对话时用于还原思考内容。
     */
    reasoningProviderOptions?: Record<string, JsonObject>;
    /** 正文片段边界用于在片段结束时持久化，而非定时保存增量。 */
    textState?: 'start' | 'end';
    done: boolean;
    finishReason?: string;
    toolCalls?: AiToolCall[];
    toolCallDeltas?: AiToolCallDelta[];
    /** 仅 done=true 的 chunk 携带：本次调用的用量。 */
    usage?: AiUsage;
    /**
     * 仅 done=true 的 chunk 携带：供应商是否真的返回了 usage（显式零也算）。
     * `usage` 会把缺失字段归一到 0，因此只能依赖这个显式信号区分
     * 「报告了零」与「什么都没报告」。
     */
    usageReported?: boolean;
}

// ============================================================================
// 用量与耗时
// ============================================================================

/**
 * 一次 LLM 调用的用量，已归一到「新鲜输入」语义。
 *
 * 归一规则：
 * - OpenAI 的 `prompt_tokens` **含**缓存命中，需减去 cacheRead + cacheWrite
 * - Anthropic 的 `input_tokens` **不含**缓存，直接用
 * - AI SDK v6 已通过 `inputTokenDetails.noCacheTokens` 统一，优先用它
 *
 * `reasoningTokens` 是 `outputTokens` 的子集（输出已包含推理），单独记录
 * 是为了在 UI 上显示「其中推理 N」，**不可重复累加**。
 */
export interface AiUsage {
    /** 新鲜输入（不含缓存读写） */
    inputTokens: number;
    /** 输出（含推理） */
    outputTokens: number;
    /** 从缓存读取的 prompt token */
    cacheReadTokens: number;
    /** 写入缓存的 prompt token（Anthropic 的 cache_creation_input_tokens） */
    cacheWriteTokens: number;
    /** 推理 token，是 outputTokens 的子集 */
    reasoningTokens: number;
    /** 供应商回复自称的模型 id（raw 里有才记，用于账单对账） */
    servedModel?: string;
    /** 供应商原始 usage，仅用于排查，不落统计表 */
    raw?: JsonObject;
}

/**
 * 一次调用的耗时分解，单位毫秒。
 *
 * `flowMs` 是「10% 内容 → 90% 内容」的窗口，用于计算可信的解码速度。
 * 供应商把回复憋住一次性吐出时 `flowMs ≈ 0`，此时不显示速度而非给假数字。
 */
export interface AiTiming {
    /** 请求发出 → 第一个内容块（文本/推理/工具调用） */
    ttftMs?: number;
    /** 请求发出 → 第一个正文块（排除推理） */
    firstTextMs?: number;
    /** 10% → 90% 内容窗口 */
    flowMs?: number;
    /** 整次调用耗时 */
    durationMs: number;
}

/** 零值，用作累加初值 */
export function emptyAiUsage(): AiUsage {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
    };
}

/** 累加两次调用的用量（用于 attempt / turn 级汇总）。 */
export function addAiUsage(left: AiUsage, right: AiUsage): AiUsage {
    return {
        inputTokens: left.inputTokens + right.inputTokens,
        outputTokens: left.outputTokens + right.outputTokens,
        cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
        cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
        reasoningTokens: left.reasoningTokens + right.reasoningTokens,
        servedModel: right.servedModel ?? left.servedModel,
        raw: left.raw ?? right.raw,
    };
}

/**
 * 非流式调用的标准响应。
 */
export interface AiResponse {
    content: string;
    /** @deprecated 用 usage 代替 */
    tokensUsed?: number;
    usage?: AiUsage;
    finishReason?: string;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
    [key: string]: JsonValue | undefined;
}

/**
 * 暴露给模型的工具定义。
 */
export interface AiToolDefinition {
    name: string;
    description: string;
    input_schema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
        [key: string]: unknown;
    };
}

/**
 * 模型在一次响应中声明的工具调用。
 */
export interface AiToolCall {
    id: string;
    name: string;
    arguments: string;
    providerOptions?: Record<string, JsonObject>;
}

/**
 * 工具调用参数在流式阶段的增量快照。
 */
export interface AiToolCallDelta {
    index: number;
    callId?: string;
    name?: string;
    argumentsDelta?: string;
    argumentsBuffer: string;
    isComplete?: boolean;
}
