import { normalizeOptionalString } from '@/utils/text';

import type { WebSearchRequest, WebSearchResult } from '../helper';
import { recencyStartDate, resultLimit } from './common';
import { buildDeepSeekToolsUrl } from './deepseekEndpoint';
import { deepSeekRequestScheduler, runWithDeepSeekRetry } from './deepseekThrottle';
import { createSearchProviderAdapter } from './define';
import { WebSearchHttpError } from './types';

/**
 * DeepSeek 官方对 `query` 的硬约束：1–128 Unicode 字符。
 * JS 的 `string.length` 按 UTF-16 码元计数，对代理对只会更保守，方向是安全的。
 */
export const DEEPSEEK_QUERY_MAX_CHARS = 128;

/** `site:` 操作符上限，避免把 query 预算全部吃在站点限定上。 */
export const DEEPSEEK_MAX_SITE_OPERATORS = 8;

/** `rerank_score` 低于该值的结果基本无相关度，直接丢弃。 */
export const DEEPSEEK_MIN_RESULT_SCORE = 1;

/** `authority` 达到该值即为官方文档定义的「高权威来源」。 */
export const DEEPSEEK_AUTHORITY_THRESHOLD = 3;

/** 「优先官方来源」启用时，至少要有这么多高权威结果才值得做收敛。 */
export const DEEPSEEK_MIN_AUTHORITATIVE_RESULTS = 3;

/**
 * 把统一搜索请求映射为 DeepSeek 支持的搜索引擎语法。
 *
 * `domains` 映射为 `site:`（多站点用 `OR` 连接），`recencyDays` 映射为 `after:`。
 * 官方没有 `domains` 之类的结构化参数，只能走 query 操作符。
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

    // 预算不足时丢弃操作符而不是截断 query：截断会改变检索语义。
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

/**
 * 把单条 DeepSeek 结果映射为统一结构。
 *
 * 官方定位：`summary`（600–800 字）给模型读，`snippet`（100–200 字）给 UI 展示，
 * 所以这里优先取 `summary` 作为模型可见的摘要。
 */
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
        // 官方用 -1 表示未知权威度，统一归一化为 undefined。
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
 * - 丢弃 `rerank_score` 明显偏低的结果；
 * - 用户开启「优先官方来源」且高权威结果足够时，收敛到高权威子集。
 */
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

/**
 * 按官方错误表把状态码翻译成可操作的提示。
 *
 * 这些状态码都属于「不改请求就不要重试」的确定性失败，
 * 裸的 `HTTP 402` 对用户没有指导意义。
 */
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

        // 重试放在调度器外层：每次重试都重新排队，避免退避后立刻再撞 429。
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
