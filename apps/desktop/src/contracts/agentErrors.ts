// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { type SourceText, tt } from '@/i18n';

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

/**
 * 错误消息映射表
 */
const ERROR_MESSAGES: Record<AiErrorCode, SourceText> = {
    // 模型相关
    [AiErrorCode.NO_ACTIVE_MODEL]: '未配置可用的 AI 模型，请前往设置页面添加模型',
    [AiErrorCode.MODEL_NOT_FOUND]: '指定的模型不存在',
    [AiErrorCode.MODEL_DISABLED]: '该模型已被禁用',
    [AiErrorCode.PROVIDER_DISABLED]: '该服务商已被禁用',

    // 请求相关
    [AiErrorCode.REQUEST_CANCELLED]: '请求已取消',
    [AiErrorCode.EMPTY_RESPONSE]: '模型返回了空回复，请尝试重新提问或更换模型',
    [AiErrorCode.STREAM_ERROR]: '流式响应处理失败',
    [AiErrorCode.SESSION_ACTIVE_TASK_EXISTS]: '当前会话已有正在运行的任务，请等待完成或先取消',
    [AiErrorCode.TASK_NOT_FOUND]: '任务不存在或已结束',
    [AiErrorCode.UNSUPPORTED_INPUT]: '当前模型不支持图片/文件输入，请选择合适模型继续。',

    // 网络相关
    [AiErrorCode.NETWORK_ERROR]: '网络连接失败，请检查网络设置',
    [AiErrorCode.API_ERROR]: 'API 请求失败',
    [AiErrorCode.TIMEOUT]: '请求超时，请稍后重试',
    [AiErrorCode.RATE_LIMIT]: '请求频率过高，请稍后重试',
    [AiErrorCode.SERVICE_UNAVAILABLE]: '服务暂时不可用，请稍后重试',
    [AiErrorCode.BAD_GATEWAY]: '网关错误，请稍后重试',
    [AiErrorCode.GATEWAY_TIMEOUT]: '网关超时，请稍后重试',

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

    // 未知错误
    [AiErrorCode.UNKNOWN]: '未知错误',
};

function isUnsupportedInputEndpointMessage(message: string): boolean {
    return /no endpoints found that support\b(?=.*\b(?:image|file)s?\b).*\binputs?\b/i.test(
        message
    );
}

function isTransportNetworkErrorMessage(message: string): boolean {
    return (
        message.includes('error sending request for url') ||
        message.includes('failed to fetch') ||
        message.includes('network') ||
        message.includes('fetch')
    );
}

function getDisplayMessageForText(message: string): string {
    const source = Object.values(ERROR_MESSAGES).find((candidate) => candidate === message);
    if (source) {
        return tt(source);
    }

    if (isUnsupportedInputEndpointMessage(message)) {
        return tt(ERROR_MESSAGES[AiErrorCode.UNSUPPORTED_INPUT]);
    }

    return message;
}

/**
 * AI 服务统一错误类
 */
export class AiError extends Error {
    public readonly code: AiErrorCode;
    public readonly details?: unknown;
    public readonly cause?: unknown;
    private readonly usesDefaultMessage: boolean;

    constructor(
        code: AiErrorCode,
        details?: unknown,
        message?: string,
        options: { cause?: unknown } = {}
    ) {
        const usesDefaultMessage = message === undefined || message === '';
        const finalMessage = usesDefaultMessage ? ERROR_MESSAGES[code] : message;
        super(finalMessage);

        this.name = 'AiError';
        this.code = code;
        this.details = details;
        this.cause = options.cause;
        this.usesDefaultMessage = usesDefaultMessage;

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
     * Localize known default AiError messages after they have crossed a string-only boundary.
     */
    static getKnownDefaultDisplayMessage(message: string): string {
        return getDisplayMessageForText(message);
    }

    /**
     * 获取适合 UI 展示的本地化消息。
     *
     * 只有应用生成的默认错误文案会被本地化；provider/API 返回的自定义消息保持原样，
     * 避免破坏远端 payload 的诊断价值。
     */
    getDisplayMessage(): string {
        if (this.usesDefaultMessage) {
            return tt(ERROR_MESSAGES[this.code]);
        }

        return getDisplayMessageForText(this.message);
    }

    /**
     * 获取任意错误对象适合 UI 展示的消息。
     */
    static getDisplayMessage(error: unknown): string {
        if (error instanceof AiError) {
            return error.getDisplayMessage();
        }

        if (error instanceof Error) {
            return getDisplayMessageForText(error.message);
        }

        return getDisplayMessageForText(String(error));
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
        // 网络相关的临时性错误都可以重试
        return [
            AiErrorCode.NETWORK_ERROR,
            AiErrorCode.TIMEOUT,
            AiErrorCode.STREAM_ERROR,
            AiErrorCode.RATE_LIMIT,
            AiErrorCode.SERVICE_UNAVAILABLE,
            AiErrorCode.BAD_GATEWAY,
            AiErrorCode.GATEWAY_TIMEOUT,
            AiErrorCode.EMPTY_RESPONSE,
        ].includes(this.code);
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
            AiErrorCode.UNSUPPORTED_INPUT,
        ].includes(this.code);
    }

    /**
     * 从普通 Error 转换为 AiError
     */
    static fromError(error: unknown, defaultCode = AiErrorCode.UNKNOWN): AiError {
        if (error instanceof AiError && error.code !== AiErrorCode.UNKNOWN) {
            return error;
        }

        const cause = error === undefined ? undefined : error;

        if (error instanceof Error || typeof error == 'string') {
            const message = error instanceof Error ? error.message.toLowerCase() : error;
            const originalMessage = error instanceof Error ? error.message : String(error);

            if (isUnsupportedInputEndpointMessage(originalMessage)) {
                return new AiError(AiErrorCode.UNSUPPORTED_INPUT, error, undefined, {
                    cause,
                });
            }

            // 取消相关（abort / cancel / AbortError）
            if (
                message.includes('abort') ||
                message.includes('cancel') ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                return new AiError(AiErrorCode.REQUEST_CANCELLED, error, undefined, {
                    cause,
                });
            }

            // 网络错误
            if (isTransportNetworkErrorMessage(message)) {
                return new AiError(AiErrorCode.NETWORK_ERROR, error, undefined, {
                    cause,
                });
            }

            // 超时
            if (message.includes('timeout')) {
                return new AiError(AiErrorCode.TIMEOUT, error, originalMessage, {
                    cause,
                });
            }

            return new AiError(defaultCode, error, originalMessage, { cause });
        }

        return new AiError(defaultCode, undefined, String(error), { cause });
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
