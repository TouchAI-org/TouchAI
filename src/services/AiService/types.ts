// Copyright (c) 2026. 千诚. Licensed under GPL v3

/**
 * AI 服务类型定义
 */

export type AiContentPart =
    | { type: 'text'; text: string }
    | { type: 'image'; mimeType: string; data: string }
    | { type: 'file'; name: string; content: string; isBinary: boolean }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface AiMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string | AiContentPart[];
    // 助手消息调用工具时：
    tool_calls?: AiToolCall[];
    // 工具结果消息：
    tool_call_id?: string;
    name?: string; // 工具结果对应的工具名
}

export interface AiRequestOptions {
    model: string;
    messages: AiMessage[];
    stream?: boolean;
    signal?: AbortSignal;
    tools?: AiToolDefinition[];
    maxTokens?: number;
}

export interface AiStreamChunk {
    content: string;
    reasoning?: string; // 推理内容（thinking process）
    done: boolean;
    finishReason?: string; // 'stop' | 'tool_calls' | 'end_turn'
    toolCalls?: AiToolCall[]; // 累积的工具调用（当 finishReason 为工具相关时在 done 时返回）
    toolEvent?: ToolEvent; // Agent 循环事件（由 run 发出，而非 provider）
}

export interface AiResponse {
    content: string;
    tokensUsed?: number;
    finishReason?: string;
}

export interface ModelInfo {
    id: string;
    name: string;
}

export interface AiProvider {
    name: string;
    type: 'openai' | 'anthropic';

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
}

export interface AiProviderConfig {
    apiEndpoint: string;
    apiKey?: string;
}

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

export interface AiToolCall {
    id: string; // 模型返回的 tool_call_id
    name: string; // 模型返回的命名空间名称
    arguments: string; // JSON 字符串
}

export type ToolEvent =
    | {
          type: 'call_start';
          callId: string;
          toolName: string;
          namespacedName: string;
          serverId: number;
          arguments: Record<string, unknown>;
      }
    | { type: 'call_end'; callId: string; result: string; isError: boolean; durationMs: number }
    | { type: 'iteration_start'; iteration: number }
    | { type: 'iteration_end'; iteration: number };
