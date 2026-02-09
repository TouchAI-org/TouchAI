// Copyright (c) 2025. 千诚. Licensed under GPL v3

/**
 * AI 服务类型定义
 */

export type AiContentPart =
    | { type: 'text'; text: string }
    | { type: 'image'; mimeType: string; data: string }
    | { type: 'file'; name: string; content: string; isBinary: boolean };

export interface AiMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | AiContentPart[];
}

export interface AiRequestOptions {
    model: string;
    messages: AiMessage[];
    stream?: boolean;
}

export interface AiStreamChunk {
    content: string;
    reasoning?: string; // 推理内容（thinking process）
    done: boolean;
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
