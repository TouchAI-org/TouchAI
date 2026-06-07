// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * AI service error codes shared across runtime boundaries.
 */
export enum AiErrorCode {
    // 模型相关错误 (1xxx)
    NO_ACTIVE_MODEL = 'NO_ACTIVE_MODEL',
    MODEL_NOT_FOUND = 'MODEL_NOT_FOUND',
    MODEL_DISABLED = 'MODEL_DISABLED',
    PROVIDER_DISABLED = 'PROVIDER_DISABLED',

    // 请求相关错误 (2xxx)
    REQUEST_CANCELLED = 'REQUEST_CANCELLED',
    EMPTY_RESPONSE = 'EMPTY_RESPONSE',
    STREAM_ERROR = 'STREAM_ERROR',
    SESSION_ACTIVE_TASK_EXISTS = 'SESSION_ACTIVE_TASK_EXISTS',
    TASK_NOT_FOUND = 'TASK_NOT_FOUND',
    UNSUPPORTED_INPUT = 'UNSUPPORTED_INPUT',

    // 网络相关错误 (3xxx) - 可重试
    NETWORK_ERROR = 'NETWORK_ERROR',
    API_ERROR = 'API_ERROR',
    TIMEOUT = 'TIMEOUT',
    RATE_LIMIT = 'RATE_LIMIT',
    SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
    BAD_GATEWAY = 'BAD_GATEWAY',
    GATEWAY_TIMEOUT = 'GATEWAY_TIMEOUT',

    // 认证相关错误 (4xxx)
    INVALID_API_KEY = 'INVALID_API_KEY',
    UNAUTHORIZED = 'UNAUTHORIZED',

    // 配置相关错误 (5xxx)
    INVALID_CONFIG = 'INVALID_CONFIG',
    MISSING_ENDPOINT = 'MISSING_ENDPOINT',

    // MCP 相关错误 (6xxx)
    MCP_CONNECTION_FAILED = 'MCP_CONNECTION_FAILED',
    MCP_TOOL_EXECUTION_FAILED = 'MCP_TOOL_EXECUTION_FAILED',
    MCP_TOOL_TIMEOUT = 'MCP_TOOL_TIMEOUT',
    // 未知错误
    UNKNOWN = 'UNKNOWN',
}

export interface SerializedAiError {
    name: 'AiError';
    code: AiErrorCode;
    message: string;
    details?: unknown;
}
