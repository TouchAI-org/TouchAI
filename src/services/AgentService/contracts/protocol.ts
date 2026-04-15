// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderDriver } from '@database/schema';

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
    stream?: boolean;
    signal?: AbortSignal;
    tools?: AiToolDefinition[];
    maxTokens?: number;
    attachmentRequestIndex?: number;
    onAttachmentManifestResolved?: (
        request: AttachmentDeliveryManifestRequest
    ) => Promise<void> | void;
}

/**
 * provider 流式输出到应用层的统一增量。
 */
export interface AiStreamChunk {
    content: string;
    reasoning?: string;
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
