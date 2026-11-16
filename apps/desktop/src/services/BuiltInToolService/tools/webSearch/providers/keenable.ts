import { normalizeOptionalString } from '@/utils/text';

import type { WebSearchRequest, WebSearchResult } from '../helper';
import { resultLimit } from './common';
import { createSearchProviderAdapter } from './define';
import { WebSearchHttpError } from './types';

const KEENABLE_API_ROOT = 'https://api.keenable.ai';

/** 无 Key 调用必须声明调用方名称，否则接口返回 400 `Missing app identifier`。 */
export const KEENABLE_APP_TITLE = 'TouchAI';

/** 多个站点只能写进 query（`site:a OR site:b`）；`site` 参数只接受一个主机。 */
const KEENABLE_MAX_SITE_OPERATORS = 5;

export function buildKeenableSearchUrl(endpoint: string | null | undefined, keyed: boolean): URL {
    const trimmed = (endpoint ?? '').trim().replace(/\/+$/, '');
    const root = trimmed || KEENABLE_API_ROOT;
    return new URL(`${root}${keyed ? '/v1/search' : '/v1/search/public'}`);
}

export function buildKeenableQuery(request: WebSearchRequest): string {
    const domains = request.domains
        .map((domain) => domain.trim())
        .filter(Boolean)
        .slice(0, KEENABLE_MAX_SITE_OPERATORS);
    if (domains.length < 2) {
        return request.query;
    }
    return `${request.query} (${domains.map((domain) => `site:${domain}`).join(' OR ')})`;
}

export function toKeenableResult(item: unknown): WebSearchResult | null {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
    }

    const record = item as Record<string, unknown>;
    const title = normalizeOptionalString(record.title);
    const url = normalizeOptionalString(record.url);
    // 卡片会把它直接绑到 `<a :href>`，非 http(s) 一律不收。
    if (!title || !url || !/^https?:\/\//i.test(url)) {
        return null;
    }

    return {
        title,
        url,
        snippet:
            normalizeOptionalString(record.snippet) ?? normalizeOptionalString(record.description),
        source: 'Keenable',
        publishedAt: normalizeOptionalString(record.published_at),
    };
}

const KEENABLE_FAILURE_HINTS: Record<number, string> = {
    400: 'Keenable rejected the search request.',
    401: 'Keenable API key is missing or invalid.',
    402: 'Keenable credits are exhausted; buy credits or wait for the monthly reset.',
    403: 'Keenable rejected the request by its security policy.',
    429: 'Keenable rate limit exceeded.',
};

export function describeKeenableFailure(error: unknown): Error {
    if (error instanceof WebSearchHttpError) {
        const hint = KEENABLE_FAILURE_HINTS[error.status];
        if (hint) {
            return new Error(`${hint} (${error.message})`);
        }
    }
    return error instanceof Error ? error : new Error(String(error));
}

/**
 * Keenable 的语义索引更适合“描述你想要的页面”，因此 query 原样发送，
 * 只把站点、时间窗口映射到它支持的参数上。
 */
export const keenableAdapter = createSearchProviderAdapter({
    id: 'keenable',
    async search({ request, settings, signal, fetchJson }) {
        const config = settings.providers.keenable;
        const apiKey = config.apiKey.trim();
        const url = buildKeenableSearchUrl(config.endpoint, Boolean(apiKey));
        const singleDomain = request.domains.length === 1 ? request.domains[0]?.trim() : '';
        const body: Record<string, unknown> = {
            query: buildKeenableQuery(request),
            max_results: resultLimit(request),
            snippet_max_length: 400,
            mode: request.intent === 'news' ? 'realtime' : 'pro',
        };
        if (singleDomain) {
            body.site = singleDomain;
        }
        if (request.recencyDays !== undefined) {
            // Keenable 接受 `7d` 这样的相对时间，本身避免时区换算出错。
            body.published_after = `${request.recencyDays}d`;
        }

        const payload = await fetchJson(url, signal, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { 'X-API-Key': apiKey } : { 'X-Keenable-Title': KEENABLE_APP_TITLE }),
            },
            body: JSON.stringify(body),
        }).catch((error: unknown) => {
            throw describeKeenableFailure(error);
        });

        const results =
            payload &&
            typeof payload === 'object' &&
            Array.isArray((payload as { results?: unknown }).results)
                ? (payload as { results: unknown[] }).results
                : [];
        return results
            .map(toKeenableResult)
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
