// Copyright (c) 2026. 千诚. Licensed under GPL v3

/**
 * AI 服务类型定义
 */

import type { ProviderDriver } from '@database/schema';

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
    name?: string; // 工具结果对应的工具名
    isError?: boolean; // 工具结果是否为失败/拒绝，供 provider 做协议级兼容
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
    reasoning?: string; // 推理内容（thinking process）
    done: boolean;
    finishReason?: string; // 'stop' | 'tool_calls' | 'end_turn'
    toolCalls?: AiToolCall[]; // 累积的工具调用（当 finishReason 为工具相关时在 done 时返回）
    toolCallDeltas?: AiToolCallDelta[]; // 工具参数的流式增量（用于 ShowWidget 等实时预览）
    toolEvent?: ToolEvent; // Agent 循环事件（由 run 发出，而非 provider）
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

export interface ModelInfo {
    id: string;
    name: string;
}

export interface ProviderConfigJson {
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
}

export interface ProviderApiTargets {
    normalizedBaseUrl: string;
    sdkBaseUrl: string;
    generationTarget: string;
    discoveryTarget: string;
}

/**
 * 不同模型服务商适配器需要实现的统一接口。
 */
export interface AiProvider {
    name: string;
    driver: ProviderDriver;

    /**
     * 发送请求到 AI 提供商
     */
    request(options: AiRequestOptions): Promise<AiResponse>;

    /**
     * 流式响应
     */
    stream(options: AiRequestOptions): AsyncGenerator<AiStreamChunk, void, unknown>;

    /**
     * 测试连接
     */
    testConnection(): Promise<boolean>;

    /**
     * 获取可用模型列表
     */
    listModels(): Promise<ModelInfo[]>;

    /**
     * 获取当前配置实际命中的 API 目标。
     */
    getApiTargets(): ProviderApiTargets;
}

export interface AiProviderConfig {
    apiEndpoint: string;
    apiKey?: string;
    config?: ProviderConfigJson | null;
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
    id: string; // 模型返回的 tool_call_id
    name: string; // 模型返回的命名空间名称
    arguments: string; // JSON 字符串
    /**
     * 存储 provider 特殊数据。
     */
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

export type ToolExecutionSource = 'mcp' | 'builtin';

/**
 * 工具审批卡片需要展示的标准字段。
 */
export interface ToolApprovalRequest {
    title: string;
    description: string;
    command: string;
    riskLabel: string;
    reason: string;
    commandLabel: string;
    approveLabel: string;
    rejectLabel: string;
    enterHint: string;
    escHint: string;
    keyboardApproveDelayMs?: number;
}

/**
 * 用于 requestToolApproval 回调的 payload。
 * 需要携带 callId，便于 UI 层在同一会话内匹配审批卡片。
 */
export interface ToolApprovalDecisionRequest extends ToolApprovalRequest {
    callId: string;
}

export interface ToolEventModelSummary {
    providerId: number;
    providerName: string;
    modelId: string;
    modelName: string;
}

export type ToolEventBuiltInConversationSemanticAction =
    | 'process'
    | 'run'
    | 'search'
    | 'read'
    | 'review'
    | 'update'
    | 'switch'
    | 'render'
    | 'remove';

export interface ToolEventBuiltInConversationSemantic {
    action: ToolEventBuiltInConversationSemanticAction;
    target?: string;
}

export type ShowWidgetMode = 'render' | 'remove';
export type ShowWidgetPhase = 'draft' | 'ready';

/**
 * widget 类工具向前端发出的渲染事件载荷。
 */
export interface ShowWidgetEventPayload {
    callId: string;
    widgetId: string;
    title: string;
    description: string;
    html: string;
    mode: ShowWidgetMode;
    phase: ShowWidgetPhase;
}

/**
 * Agent 循环过程中发给 UI 的统一事件。
 */
export type ToolEvent =
    | {
          type: 'call_start';
          callId: string;
          toolName: string;
          namespacedName: string;
          source: ToolExecutionSource;
          serverId?: number | null;
          sourceLabel?: string;
          arguments: Record<string, unknown>;
          builtinConversationSemantic?: ToolEventBuiltInConversationSemantic;
      }
    | {
          type: 'call_end';
          callId: string;
          result: string;
          isError: boolean;
          durationMs: number;
          finalStatus?: 'completed' | 'error' | 'rejected';
      }
    | ({ type: 'approval_required'; callId: string } & ToolApprovalRequest)
    | {
          type: 'approval_resolved';
          callId: string;
          approved: boolean;
          resolutionText?: string;
      }
    | ({ type: 'widget_upsert' } & ShowWidgetEventPayload)
    | {
          type: 'widget_remove';
          callId: string;
          widgetId: string;
      }
    | {
          type: 'model_switched';
          fromModel: ToolEventModelSummary;
          toModel: ToolEventModelSummary;
          restart: boolean;
      }
    | {
          type: 'request_retry';
          attempt: number;
          maxRetries: number;
          reason: string;
      }
    | { type: 'iteration_start'; iteration: number }
    | { type: 'iteration_end'; iteration: number };
