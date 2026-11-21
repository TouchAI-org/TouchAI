import { normalizeOptionalString } from '@/utils/text';

import type { WebSearchRequest, WebSearchResult } from '../helper';
import { nativeSearchOptions, queryWithDomains, recencyStartDate, resultLimit } from './common';
import { createSearchProviderAdapter } from './define';
import { SearchProviderCapabilityError, WebSearchHttpError } from './types';

/** 官方同时接受 `/` 与 `/v1` 结尾，先剥版本段再统一拼接，避免 `/v1/v1/...`。 */
const DEEPSEEK_API_ROOT = 'https://api.deepseek.com';

/** 拼接 DeepSeek 搜索接口地址。Fetch 尚未接入，等接入时再扩展。 */
export function buildDeepSeekToolsUrl(endpoint: string | null | undefined): string {
    const trimmed = (endpoint ?? '').trim().replace(/\/+$/, '');
    const root = trimmed ? trimmed.replace(/\/v1$/i, '') : DEEPSEEK_API_ROOT;
    return `${root}/v1/tools/search`;
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

/** 官方对 `query` 的硬约束：1–128 字符。 */
export const DEEPSEEK_QUERY_MAX_CHARS = 128;

/** 官方定义 `authority >= 3` 为高权威来源。 */
const DEEPSEEK_AUTHORITY_THRESHOLD = 3;

/** 高权威结果少于这个数量时不做收敛，否则会丢掉太多有效结果。 */
const DEEPSEEK_MIN_AUTHORITATIVE_RESULTS = 3;

/** Preserve every requested filter; never silently broaden a constrained search. */
export function buildDeepSeekQuery(request: WebSearchRequest): string {
    const after = recencyStartDate(request.recencyDays);
    const query = [queryWithDomains(request).trim(), after ? `after:${after.slice(0, 10)}` : '']
        .filter(Boolean)
        .join(' ');
    if ([...query].length > DEEPSEEK_QUERY_MAX_CHARS) {
        // 能力上限而非鉴权/网络错误：自动路由可以换一个能接受长查询的引擎。
        throw new SearchProviderCapabilityError(
            'DeepSeek search accepts at most 128 query characters including filters. Shorten the query or split the site filters across calls.'
        );
    }
    return query;
}

/**
 * 把单条 DeepSeek 结果映射为统一结构。
 *
 * 官方定位：`summary`（600-800 字）给模型读，`snippet`（100-200 字）给 UI 展示，
 * 所以这里优先取 `summary` 作为模型可见的摘要。
 */
export function toDeepSeekResult(item: unknown): WebSearchResult | null {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
    }

    const record = item as Record<string, unknown>;
    const title = normalizeOptionalString(record.title);
    const url = normalizeOptionalString(record.url);
    // 只收 http(s)：上层会把它直接绑到 `<a :href>`，
    // 放行 `javascript:` / `data:` 会把搜索结果变成脚本入口。
    if (!title || !url || !/^https?:\/\//i.test(url)) {
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

/**
 * 应用 DeepSeek 自带的质量信号。
 *
 * 「优先官方来源」是排序而非过滤：低权威结果保留在后（中文长尾站点普遍 authority < 3）。
 * All provider results remain eligible regardless of their relevance score.
 */
export function rankDeepSeekResults(
    results: WebSearchResult[],
    preferOfficialSources: boolean
): WebSearchResult[] {
    const ranked = results;

    if (!preferOfficialSources) {
        return ranked;
    }

    const authoritativeCount = ranked.filter(
        (result) => (result.authority ?? 0) >= DEEPSEEK_AUTHORITY_THRESHOLD
    ).length;
    if (authoritativeCount < DEEPSEEK_MIN_AUTHORITATIVE_RESULTS) {
        return ranked;
    }

    // 稳定排序：高权威在前，其余保持原顺序。
    const isAuthoritative = (result: WebSearchResult) =>
        (result.authority ?? 0) >= DEEPSEEK_AUTHORITY_THRESHOLD;
    return [...ranked].sort(
        (left, right) => Number(isAuthoritative(right)) - Number(isAuthoritative(left))
    );
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
            error.message = `${hint} (${error.message})`;
            return error;
        }
    }
    return error instanceof Error || error instanceof DOMException
        ? error
        : new Error(String(error));
}

export function createDeepSeekSearchAdapter() {
    const deepSeekRequestScheduler = createRequestScheduler({
        minIntervalMs: DEEPSEEK_MIN_REQUEST_INTERVAL_MS,
    });
    return createSearchProviderAdapter({
        id: 'deepseek',

        async search({ request, settings, signal, fetchJson }) {
            const config = settings.providers.deepseek;
            const apiKey = config.apiKey.trim();
            if (!apiKey) {
                throw new Error('DeepSeek search needs an API key. Enter one in Search settings.');
            }

            const url = new URL(buildDeepSeekToolsUrl(config.endpoint));
            const body = JSON.stringify({
                query: buildDeepSeekQuery(request),
                count: resultLimit(request, 50),
                need_content: request.includeContent === true,
                ...nativeSearchOptions(request, 'deepseek'),
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
}
