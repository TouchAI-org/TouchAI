// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderDriver } from '@database/schema';

import type { ModelLanguageContext } from '../languageContext';
import type { ReasoningOption, SelectableReasoningLevel } from './reasoning';
import type { AiToolCall, AiToolCallDelta, AiToolDefinition, ToolEvent } from './tooling';

export type AttachmentTransportMode =
    | 'inline-image'
    | 'inline-text'
    | 'inline-base64'
    | 'provider-file-ref'
    | 'external-url';

export type AttachmentDerivedKind =
    | 'image'
    | 'pdf'
    | 'text'
    | 'code'
    | 'structured-text'
    | 'binary'
    | 'directory';

export type AttachmentSemanticIntent =
    | 'visual-reference'
    | 'document-content'
    | 'textual-content'
    | 'binary-content'
    | 'directory-reference';

export type AttachmentMessagePositionMode = 'inline' | 'synthetic-user-hoist';

export interface AttachmentTransportDecision {
    kind: AttachmentDerivedKind;
    transportMode: AttachmentTransportMode;
    reason: string;
    shouldUpload: boolean;
    canReuseRemoteRef: boolean;
    messagePositionMode: AttachmentMessagePositionMode;
}

export interface AttachmentPromptMeta {
    alias: string;
    order: number;
    type: 'image' | 'file';
    name: string;
    mimeType: string | null;
    originPath: string;
    attachmentId: number | null;
    hash: string | null;
}

export interface AttachmentDeliveryManifestEntry {
    messageIndex: number;
    partIndex: number;
    sourceRole: 'user' | 'tool';
    resolvedRole: 'user' | 'tool';
    messageContext: 'user' | 'tool-result';
    toolCallId?: string;
    toolName?: string;
    alias: string;
    order: number;
    type: 'image' | 'file';
    name: string;
    size: number | null;
    mimeType: string;
    originPath: string;
    sourcePath: string;
    attachmentId: number | null;
    hash: string | null;
    derivedKind: AttachmentDerivedKind;
    semanticIntent: AttachmentSemanticIntent;
    transportMode: AttachmentTransportMode;
    messagePositionMode: AttachmentMessagePositionMode;
    transportReason: string;
    remoteRefStrategy?: string | null;
}

export interface AttachmentDeliveryManifestRequest {
    requestIndex: number;
    providerDriver: ProviderDriver;
    providerId: number | null;
    modelId: string;
    createdAt: string;
    entries: AttachmentDeliveryManifestEntry[];
}

export interface AttachmentDeliveryManifest {
    version: 1;
    requests: AttachmentDeliveryManifestRequest[];
}

/**
 * 单条消息内容在应用内部的统一片段表示。
 */
export type AiContentPart =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string; providerOptions?: Record<string, JsonObject> }
    | {
          type: 'image';
          name: string;
          sourcePath: string;
          size: number | null;
          mimeType: string;
          data: string;
          kind: 'image';
          semanticIntent: AttachmentSemanticIntent;
          meta: AttachmentPromptMeta;
      }
    | {
          type: 'file';
          name: string;
          sourcePath: string;
          size: number | null;
          mimeType: string;
          kind: Exclude<AttachmentDerivedKind, 'image'>;
          semanticIntent: AttachmentSemanticIntent;
          textContent?: string;
          base64Data?: string;
          meta: AttachmentPromptMeta;
      }
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
    providerId?: number;
    messages: AiMessage[];
    supportsReasoning?: boolean;
    reasoningLevel?: SelectableReasoningLevel;
    /** 上游 /models 或本地 metadata 声明的 reasoning 能力。 */
    reasoningOptions?: ReasoningOption[];
    stream?: boolean;
    signal?: AbortSignal;
    tools?: AiToolDefinition[];
    modelLanguageContext?: ModelLanguageContext;
    attachmentRequestIndex?: number;
    onAttachmentManifestResolved?: (
        request: AttachmentDeliveryManifestRequest
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
    toolEvent?: ToolEvent;
    /** 仅 done=true 的 chunk 携带：本次调用的用量。 */
    usage?: AiUsage;
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

/** 一次 LLM 调用的完整记录（用量 + 耗时 + 归属）。 */
export interface AiCallRecord {
    /** 该 attempt 内的第几轮工具循环（从 0 开始） */
    iteration: number;
    /** 调用时的模型 */
    modelId: number;
    modelName: string;
    providerId: number | null;
    providerName: string;
    usage: AiUsage;
    timing: AiTiming;
    /** 结束原因：stop / tool_calls / length / error / aborted */
    finishReason?: string;
    /** 非正常结束时的错误信息 */
    errorMessage?: string;
    /** 本轮发起的工具调用数 */
    toolCallsInStep: number;
    /** 本轮参数解析失败的次数 */
    toolArgumentErrors: number;
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

/** Ordered text/reasoning output shared by execution and persistence. */
export type PersistedOutputPart =
    | { type: 'text'; content: string }
    | {
          type: 'reasoning';
          content: string;
          startedAt?: number;
          endedAt?: number;
          providerOptions?: Record<string, JsonObject>;
      };
/** Validate the sole persisted output format without changing logical order. */
export function normalizeOutputParts(raw: unknown): PersistedOutputPart[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((value): PersistedOutputPart[] => {
        if (!value || typeof value !== 'object') return [];
        const part = value as {
            type?: unknown;
            content?: unknown;
            startedAt?: unknown;
            endedAt?: unknown;
            providerOptions?: unknown;
        };
        if (typeof part.content !== 'string') return [];
        if (part.type === 'text')
            return part.content ? [{ type: 'text', content: part.content }] : [];
        if (part.type !== 'reasoning') return [];
        const startedAt = validTime(part.startedAt) ? part.startedAt : undefined;
        if (!part.content && startedAt === undefined) return [];
        const endedAt =
            startedAt !== undefined && validTime(part.endedAt) && part.endedAt >= startedAt
                ? part.endedAt
                : undefined;
        const providerOptions = validProviderOptions(part.providerOptions);
        return [
            {
                type: 'reasoning',
                content: part.content,
                ...(startedAt !== undefined ? { startedAt } : {}),
                ...(endedAt !== undefined ? { endedAt } : {}),
                ...(providerOptions ? { providerOptions } : {}),
            },
        ];
    });
}
function validTime(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
/** 仅保留可 JSON 序列化的 providerOptions，避免把任意对象写进持久层。 */
function validProviderOptions(value: unknown): Record<string, JsonObject> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const result: Record<string, JsonObject> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
        result[key] = entry as JsonObject;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}
