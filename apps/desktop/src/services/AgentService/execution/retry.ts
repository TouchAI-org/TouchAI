import { AiError, AiErrorCode } from '../contracts/errors';

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

const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 16_000;

/**
 * 计算重试延迟（指数退避 + 随机抖动）
 * @param attempt 重试次数（从 1 开始）
 * @returns 延迟毫秒数
 */
export function getRetryDelayMs(attempt: number): number {
    const exponential = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    const capped = Math.min(exponential, RETRY_MAX_DELAY_MS);
    const jitter = capped * 0.2 * Math.random(); // 0-20% 正抖动
    return Math.round(capped + jitter);
}

/**
 * 等待重试退避时间，并在等待过程中响应取消信号。
 */
export async function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (delayMs <= 0) {
        return;
    }

    if (signal?.aborted) {
        throw new AiError(AiErrorCode.REQUEST_CANCELLED);
    }

    await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            signal?.removeEventListener('abort', handleAbort);
            resolve();
        }, delayMs);

        const handleAbort = () => {
            clearTimeout(timeoutId);
            signal?.removeEventListener('abort', handleAbort);
            reject(new AiError(AiErrorCode.REQUEST_CANCELLED));
        };

        signal?.addEventListener('abort', handleAbort, { once: true });
    });
}
