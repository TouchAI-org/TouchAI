import { WebSearchHttpError } from './types';

/**
 * DeepSeek Search / Fetch 是**账号级**限流：Search 与 Fetch 各自独立 5 QPS，
 * 与 API Key 无关，也独立于模型并发额度。
 *
 * 这里按 4 QPS 排队，留出约 20% 余量给同一账号上的其它客户端，
 * 避免并行子 agent 直接把账号打到 429。
 */
export const DEEPSEEK_REQUESTS_PER_SECOND = 4;

export const DEEPSEEK_MIN_REQUEST_INTERVAL_MS = Math.ceil(1000 / DEEPSEEK_REQUESTS_PER_SECOND);

/** 官方建议重试的状态码：408 请求体超时、429 限流、5xx 服务端或下游异常。 */
export function isRetryableDeepSeekError(error: unknown): boolean {
    if (!(error instanceof WebSearchHttpError)) {
        return false;
    }
    return error.status === 408 || error.status === 429 || error.status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export interface RequestScheduler {
    /**
     * 把一次请求排进队列；返回的 Promise 表示该次请求自身的成功或失败，
     * 单次失败不会阻塞后续排队。
     */
    run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface RequestSchedulerOptions {
    /** 两次请求之间的最小间隔（毫秒）。 */
    minIntervalMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

/**
 * 串行化 + 最小间隔的请求调度器。
 *
 * 令牌桶在这里没有优势：搜索请求的耗时远大于 250ms，
 * 而「上一个请求开始后至少间隔 N 毫秒」正好对应官方的 QPS 语义。
 */
export function createRequestScheduler(options: RequestSchedulerOptions): RequestScheduler {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? defaultSleep;
    let tail: Promise<unknown> = Promise.resolve();
    let nextAvailableAt = 0;

    return {
        run<T>(operation: () => Promise<T>): Promise<T> {
            const scheduled = tail.then(async () => {
                const wait = nextAvailableAt - now();
                if (wait > 0) {
                    await sleep(wait);
                }
                nextAvailableAt = Math.max(now(), nextAvailableAt) + options.minIntervalMs;
                return await operation();
            });

            tail = scheduled.then(
                () => undefined,
                () => undefined
            );

            return scheduled;
        },
    };
}

export interface DeepSeekRetryOptions {
    attempts?: number;
    signal?: AbortSignal;
    /** 测试注入点：替代 `setTimeout`。 */
    sleep?: (ms: number) => Promise<void>;
    /** 测试注入点：抖动来源。 */
    random?: () => number;
}

export const DEEPSEEK_RETRY_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5_000;

/**
 * 计算下一次重试前的等待时间。
 *
 * 优先采用服务端 `Retry-After`，否则指数退避并叠加抖动，
 * 避免多个并发调用同时重试形成二次风暴。
 */
export function deepSeekRetryDelayMs(
    attempt: number,
    error: unknown,
    random: () => number = Math.random
): number {
    const retryAfterMs = error instanceof WebSearchHttpError ? error.retryAfterMs : undefined;
    if (retryAfterMs !== undefined) {
        return Math.min(Math.max(retryAfterMs, 0), MAX_BACKOFF_MS);
    }
    const backoff = BASE_BACKOFF_MS * 2 ** attempt;
    return Math.min(backoff + Math.floor(random() * 250), MAX_BACKOFF_MS);
}

async function sleepUnlessAborted(
    ms: number,
    signal: AbortSignal | undefined,
    sleep: (ms: number) => Promise<void>
): Promise<void> {
    if (signal?.aborted) {
        return;
    }
    await sleep(ms);
}

/**
 * 按官方错误语义重试 DeepSeek 请求。
 *
 * 只重试 408 / 429 / 5xx；400 / 401 / 402 / 403 / 404 / 413 属于
 * 「不改请求就不要重试」的确定性失败，直接上抛。
 */
export async function runWithDeepSeekRetry<T>(
    operation: () => Promise<T>,
    options: DeepSeekRetryOptions = {}
): Promise<T> {
    const attempts = options.attempts ?? DEEPSEEK_RETRY_ATTEMPTS;
    const sleep = options.sleep ?? defaultSleep;

    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            const isLastAttempt = attempt === attempts - 1;
            if (isLastAttempt || !isRetryableDeepSeekError(error) || options.signal?.aborted) {
                break;
            }
            await sleepUnlessAborted(
                deepSeekRetryDelayMs(attempt, error, options.random),
                options.signal,
                sleep
            );
            if (options.signal?.aborted) {
                break;
            }
        }
    }

    throw lastError;
}

/** 搜索与抓取各占一份配额，互不消耗对方的 QPS。 */
export const deepSeekRequestScheduler = createRequestScheduler({
    minIntervalMs: DEEPSEEK_MIN_REQUEST_INTERVAL_MS,
});
