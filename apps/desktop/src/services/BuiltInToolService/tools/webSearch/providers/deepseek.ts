import { normalizeOptionalString } from '@/utils/text';

import type { WebSearchRequest, WebSearchResult } from '../helper';
import { recencyStartDate, resultLimit } from './common';
import { createSearchProviderAdapter } from './define';
import { WebSearchHttpError } from './types';

/** 官方同时接受 `/` 与 `/v1` 结尾，先剥版本段再统一拼接，避免 `/v1/v1/...`。 */
const DEEPSEEK_API_ROOT = 'https://api.deepseek.com';

export function buildDeepSeekToolsUrl(
    endpoint: string | null | undefined,
    tool: 'search' | 'fetch'
): string {
    const trimmed = (endpoint ?? '').trim().replace(/\/+$/, '');
    const root = trimmed ? trimmed.replace(/\/v1$/i, '') : DEEPSEEK_API_ROOT;
    return `${root}/v1/tools/${tool}`;
}
/**
 * Search / Fetch 是账号级限流，各自 5 QPS。按 4 QPS 排队，
 * 给同账号的其它客户端留余量，避免并行调用直接撞 429。
 */
export const DEEPSEEK_MIN_REQUEST_INTERVAL_MS = 250;

/** 官方建议重试：408 请求体超时、429 限流、5xx。其余属确定性失败，重试无意义。 */
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
    run<T>(operation: () => Promise<T>): Promise<T>;
}

/** 「上一个请求开始后至少间隔 N 毫秒」正好对应官方 QPS 语义，比令牌桶更直接。 */
export function createRequestScheduler(options: {
    minIntervalMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}): RequestScheduler {
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

const DEEPSEEK_RETRY_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5_000;

/** 优先用服务端 `Retry-After`，否则指数退避加抖动，避免并发调用同时重试。 */
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

export async function runWithDeepSeekRetry<T>(
    operation: () => Promise<T>,
    options: {
        attempts?: number;
        signal?: AbortSignal;
        sleep?: (ms: number) => Promise<void>;
        random?: () => number;
    } = {}
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
            if (!options.signal?.aborted) {
                await sleep(deepSeekRetryDelayMs(attempt, error, options.random));
            }
            if (options.signal?.aborted) {
                break;
            }
        }
    }

    throw lastError;
}

const deepSeekRequestScheduler = createRequestScheduler({
    minIntervalMs: DEEPSEEK_MIN_REQUEST_INTERVAL_MS,
});

/** 官方对 `query` 的硬约束：1–128 字符。 */
export const DEEPSEEK_QUERY_MAX_CHARS = 128;

/** `site:` 操作符上限，避免把 query 预算全吃在站点限定上。 */
const DEEPSEEK_MAX_SITE_OPERATORS = 8;

/** 低于该 `rerank_score` 基本无相关度，直接丢弃。 */
const DEEPSEEK_MIN_RESULT_SCORE = 1;

/** 官方定义 `authority >= 3` 为高权威来源。 */
const DEEPSEEK_AUTHORITY_THRESHOLD = 3;

/** 高权威结果少于这个数量时不做收敛，否则会丢掉太多有效结果。 */
const DEEPSEEK_MIN_AUTHORITATIVE_RESULTS = 3;

/**
 * 官方没有结构化的 domains / 时间参数，只能映射为 `site:` 与 `after:` 操作符。
 * 预算不足时丢弃操作符而不是截断 query —— 截断会改变检索语义。
 */
export function buildDeepSeekQuery(request: WebSearchRequest): string {
    const query = request.query.trim();
    const operators: string[] = [];

    const domains = request.domains
        .map((domain) => domain.trim())
        .filter(Boolean)
        .slice(0, DEEPSEEK_MAX_SITE_OPERATORS);
    if (domains.length > 0) {
        operators.push(domains.map((domain) => `site:${domain}`).join(' OR '));
    }

    const after = recencyStartDate(request.recencyDays);
    if (after) {
        operators.push(`after:${after.slice(0, 10)}`);
    }

    const budget = DEEPSEEK_QUERY_MAX_CHARS - query.length - 1;
    const appended: string[] = [];
    let used = 0;
    for (const operator of operators) {
        const cost = operator.length + 1;
        if (used + cost > budget) {
            break;
        }
        appended.push(operator);
        used += cost;
    }

    return appended.length > 0 ? `${query} ${appended.join(' ')}` : query;
}

/** `summary`（600–800 字）是给模型读的，`snippet`（100–200 字）才适合 UI。 */
export function toDeepSeekResult(item: unknown): WebSearchResult | null {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
    }

    const record = item as Record<string, unknown>;
    const title = normalizeOptionalString(record.title);
    const url = normalizeOptionalString(record.url);
    if (!title || !url) {
        return null;
    }

    const authority = typeof record.authority === 'number' ? record.authority : undefined;
    const publishedAt = normalizeOptionalString(record.date);

    return {
        title,
        url,
        snippet: normalizeOptionalString(record.summary) ?? normalizeOptionalString(record.snippet),
        source: normalizeOptionalString(record.site_name) ?? safeHostname(url),
        score: typeof record.rerank_score === 'number' ? record.rerank_score : undefined,
        // 官方用 -1 表示未知权威度。
        authority: authority !== undefined && authority >= 0 ? authority : undefined,
        publishedAt,
        favicon: normalizeOptionalString(record.site_icon) ?? undefined,
        content: normalizeOptionalString(record.content) ?? undefined,
    };
}

function safeHostname(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return 'DeepSeek';
    }
}

export function rankDeepSeekResults(
    results: WebSearchResult[],
    preferOfficialSources: boolean
): WebSearchResult[] {
    const relevant = results.filter(
        (result) => result.score === undefined || result.score >= DEEPSEEK_MIN_RESULT_SCORE
    );

    if (!preferOfficialSources) {
        return relevant;
    }

    const authoritative = relevant.filter(
        (result) => (result.authority ?? 0) >= DEEPSEEK_AUTHORITY_THRESHOLD
    );
    return authoritative.length >= DEEPSEEK_MIN_AUTHORITATIVE_RESULTS ? authoritative : relevant;
}

function readDeepSeekResultItems(payload: unknown): unknown[] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return [];
    }
    const results = (payload as Record<string, unknown>).results;
    return Array.isArray(results) ? results : [];
}

/** 这些状态码属确定性失败，裸的 `HTTP 402` 对用户没有指导意义。 */
const DEEPSEEK_FAILURE_HINTS: Record<number, string> = {
    400: 'DeepSeek rejected the search request body.',
    401: 'DeepSeek API key is missing or invalid.',
    402: 'DeepSeek account has insufficient balance.',
    403: 'DeepSeek rejected the request by its security policy.',
    404: 'DeepSeek could not return usable search results.',
    413: 'DeepSeek search request body is too large.',
    429: 'DeepSeek search rate limit exceeded.',
};

export function describeDeepSeekFailure(error: unknown): Error {
    if (error instanceof WebSearchHttpError) {
        const hint = DEEPSEEK_FAILURE_HINTS[error.status];
        if (hint) {
            return new Error(`${hint} (${error.message})`);
        }
    }
    return error instanceof Error ? error : new Error(String(error));
}

export const deepSeekSearchAdapter = createSearchProviderAdapter({
    id: 'deepseek',

    async search({ request, settings, signal, fetchJson }) {
        const config = settings.providers.deepseek;
        const apiKey = config.apiKey.trim();
        if (!apiKey) {
            throw new Error(
                'DeepSeek search needs an API key: fill one in, or configure the DeepSeek service credential.'
            );
        }

        const url = new URL(buildDeepSeekToolsUrl(config.endpoint, 'search'));
        const body = JSON.stringify({
            query: buildDeepSeekQuery(request),
            count: resultLimit(request),
            need_content: request.includeContent === true,
        });

        // 重试放在调度器外层：每次重试重新排队，避免退避后立刻再撞 429。
        const payload = await runWithDeepSeekRetry(
            () =>
                deepSeekRequestScheduler.run(() =>
                    fetchJson(url, signal, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        body,
                    })
                ),
            { signal }
        ).catch((error: unknown) => {
            throw describeDeepSeekFailure(error);
        });

        const results = readDeepSeekResultItems(payload)
            .map(toDeepSeekResult)
            .filter((result): result is WebSearchResult => Boolean(result));

        return rankDeepSeekResults(results, settings.preferOfficialSources);
    },
});
