import { AiError } from './errors';

export interface RetryableRequestErrorInfo {
    statusCode?: number;
}

export const MAX_REQUEST_RETRIES = 5;

// HTTP 状态码：可重试的临时性错误
const RETRYABLE_STATUS_CODES = new Set([
    408, // Request Timeout
    409, // Conflict
    425, // Too Early
    429, // Too Many Requests
    500, // Internal Server Error
    502, // Bad Gateway
    503, // Service Unavailable
    504, // Gateway Timeout
]);

export function getRetryStatusMessage(
    attempt: number,
    maxRetries: number = MAX_REQUEST_RETRIES
): string {
    return `重试中...(${attempt}/${maxRetries})`;
}

/**
 * 判断错误是否可以重试
 * 优先使用 AiError.isRetryable()，然后检查 HTTP 状态码
 */
export function shouldRetryRequestFailure(
    error: AiError,
    details?: RetryableRequestErrorInfo | null
): boolean {
    // 首先检查错误码是否可重试
    if (error.isRetryable()) {
        return true;
    }

    // 检查 HTTP 状态码
    if (typeof details?.statusCode === 'number' && RETRYABLE_STATUS_CODES.has(details.statusCode)) {
        return true;
    }

    return false;
}

const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 5000;

/**
 * 计算重试延迟（线性退避）
 * @param attempt 重试次数（从 1 开始）
 * @returns 延迟毫秒数
 */
export function getRetryDelayMs(attempt: number): number {
    return Math.min(RETRY_BASE_DELAY_MS * attempt, RETRY_MAX_DELAY_MS);
}
