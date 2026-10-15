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
}

/**
 * 非流式调用的标准响应。
 */
export interface AiResponse {
    content: string;
    tokensUsed?: number;
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
