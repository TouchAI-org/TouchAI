// Copyright (c) 2026. 千诚. Licensed under GPL v3

/**
 * AI 服务错误码
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

    // 网络相关错误 (3xxx)
    NETWORK_ERROR = 'NETWORK_ERROR',
    API_ERROR = 'API_ERROR',
    TIMEOUT = 'TIMEOUT',

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
    MCP_MAX_ITERATIONS_REACHED = 'MCP_MAX_ITERATIONS_REACHED',

    // 未知错误
    UNKNOWN = 'UNKNOWN',
}

/**
 * 错误消息映射表
 */
const ERROR_MESSAGES: Record<AiErrorCode, string> = {
    // 模型相关
    [AiErrorCode.NO_ACTIVE_MODEL]: '未配置可用的 AI 模型，请前往设置页面添加模型',
    [AiErrorCode.MODEL_NOT_FOUND]: '指定的模型不存在',
    [AiErrorCode.MODEL_DISABLED]: '该模型已被禁用',
    [AiErrorCode.PROVIDER_DISABLED]: '该服务商已被禁用',

    // 请求相关
    [AiErrorCode.REQUEST_CANCELLED]: '请求已取消',
    [AiErrorCode.EMPTY_RESPONSE]: '模型返回了空回复，请尝试重新提问或更换模型',
    [AiErrorCode.STREAM_ERROR]: '流式响应处理失败',

    // 网络相关
    [AiErrorCode.NETWORK_ERROR]: '网络连接失败，请检查网络设置',
    [AiErrorCode.API_ERROR]: 'API 请求失败',
    [AiErrorCode.TIMEOUT]: '请求超时，请稍后重试',

    // 认证相关
    [AiErrorCode.INVALID_API_KEY]: 'API Key 无效或已过期',
    [AiErrorCode.UNAUTHORIZED]: '认证失败，请检查 API Key',

    // 配置相关
    [AiErrorCode.INVALID_CONFIG]: '配置无效',
    [AiErrorCode.MISSING_ENDPOINT]: '缺少 API 端点配置',

    // MCP 相关
    [AiErrorCode.MCP_CONNECTION_FAILED]: 'MCP 服务器连接失败',
    [AiErrorCode.MCP_TOOL_EXECUTION_FAILED]: 'MCP 工具执行失败',
    [AiErrorCode.MCP_TOOL_TIMEOUT]: 'MCP 工具执行超时',
    [AiErrorCode.MCP_MAX_ITERATIONS_REACHED]: '已达到最大迭代次数',

    // 未知错误
    [AiErrorCode.UNKNOWN]: '未知错误',
};

/**
 * AI 服务统一错误类
 */
export class AiError extends Error {
    public readonly code: AiErrorCode;
    public readonly details?: unknown;

    constructor(code: AiErrorCode, details?: unknown, message?: string) {
        const finalMessage = message || ERROR_MESSAGES[code];
        super(finalMessage);

        this.name = 'AiError';
        this.code = code;
        this.details = details;

        // 保持正确的原型链
        Object.setPrototypeOf(this, AiError.prototype);
    }

    /**
     * 获取错误码对应的消息文本
     */
    static getMessage(code: AiErrorCode): string {
        return ERROR_MESSAGES[code];
    }

    /**
     * 判断是否为特定错误码
     */
    is(code: AiErrorCode): boolean {
        return this.code === code;
    }

    /**
     * 判断是否为可重试的错误
     */
    isRetryable(): boolean {
        return [AiErrorCode.NETWORK_ERROR, AiErrorCode.TIMEOUT, AiErrorCode.STREAM_ERROR].includes(
            this.code
        );
    }

    /**
     * 判断是否为用户可操作的错误（需要用户修改配置）
     */
    isUserActionable(): boolean {
        return [
            AiErrorCode.NO_ACTIVE_MODEL,
            AiErrorCode.MODEL_DISABLED,
            AiErrorCode.PROVIDER_DISABLED,
            AiErrorCode.INVALID_API_KEY,
            AiErrorCode.UNAUTHORIZED,
            AiErrorCode.INVALID_CONFIG,
            AiErrorCode.MISSING_ENDPOINT,
        ].includes(this.code);
    }

    /**
     * 从普通 Error 转换为 AiError
     */
    static fromError(error: unknown, defaultCode = AiErrorCode.UNKNOWN): AiError {
        if (error instanceof AiError && error.code !== AiErrorCode.UNKNOWN) {
            return error;
        }

        if (error instanceof Error || typeof error == 'string') {
            // 尝试从错误消息推断错误类型
            const message = error instanceof Error ? error.message.toLowerCase() : error;

            // 检查取消相关的错误（包括 abort、cancel、cancelled）
            if (
                message.includes('abort') ||
                message.includes('cancel') ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                return new AiError(AiErrorCode.REQUEST_CANCELLED, error);
            }

            if (message.includes('network') || message.includes('fetch')) {
                return new AiError(
                    AiErrorCode.NETWORK_ERROR,
                    error,
                    error instanceof Error ? error.message : String(error)
                );
            }

            if (message.includes('timeout')) {
                return new AiError(
                    AiErrorCode.TIMEOUT,
                    error,
                    error instanceof Error ? error.message : String(error)
                );
            }

            if (message.includes('unauthorized') || message.includes('401')) {
                return new AiError(
                    AiErrorCode.UNAUTHORIZED,
                    error,
                    error instanceof Error ? error.message : String(error)
                );
            }

            if (message.includes('api key')) {
                return new AiError(
                    AiErrorCode.INVALID_API_KEY,
                    error,
                    error instanceof Error ? error.message : String(error)
                );
            }

            return new AiError(
                defaultCode,
                error,
                error instanceof Error ? error.message : String(error)
            );
        }

        return new AiError(defaultCode, undefined, String(error));
    }

    /**
     * 转换为 JSON 格式（便于日志记录）
     */
    toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            details: this.details,
        };
    }
}
