// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { AiToolCall, AiToolCallDelta, AiToolDefinition, ToolEvent } from './tooling';

/**
 * 单条消息内容在应用内部的统一片段表示。
 */
export type AiContentPart =
    | { type: 'text'; text: string }
    | { type: 'image'; mimeType: string; data: string }
    | { type: 'file'; name: string; content: string; isBinary: boolean }
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
    stream?: boolean;
    signal?: AbortSignal;
    tools?: AiToolDefinition[];
    maxTokens?: number;
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
