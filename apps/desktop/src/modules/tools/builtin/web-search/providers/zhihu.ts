import { normalizeOptionalString } from '@/utils/text';

import type { WebSearchRequest, WebSearchResult } from '../helper';
import {
    nativeSearchOptions,
    recencyStartDate,
    resultDetails,
    resultLimit,
    searchSource,
    setSearchParams,
} from './common';
import { createSearchProviderAdapter } from './define';

const ZHIHU_API_ROOT = 'https://developer.zhihu.com';
export const ZHIHU_SITE_SEARCH_PATH = '/api/v1/content/zhihu_search';
export const ZHIHU_GLOBAL_SEARCH_PATH = '/api/v1/content/global_search';

/** `zhihu_search` 单次最多 10 条，`global_search` 最多 20 条。 */
const ZHIHU_SITE_SEARCH_MAX = 10;
const ZHIHU_GLOBAL_SEARCH_MAX = 20;

export function buildZhihuSearchUrl(
    request: WebSearchRequest,
    endpoint: string | null | undefined
): { url: URL; siteOnly: boolean } {
    const trimmed = (endpoint ?? '').trim().replace(/\/+$/, '');
    const root = trimmed || ZHIHU_API_ROOT;
    const domains = request.domains.map((domain) => domain.trim().toLowerCase());
    const { searchType, ...options } = nativeSearchOptions(request, 'zhihu');
    if (searchType !== undefined && !['global', 'zhihu'].includes(String(searchType)))
        throw new Error('Zhihu searchType must be global or zhihu.');
    const siteOnly =
        searchType === 'zhihu' ||
        (searchType !== 'global' &&
            (searchSource(request) === 'community' ||
                (domains.length === 1 && /(^|\.)zhihu\.com$/.test(domains[0] ?? ''))));
    const url = new URL(`${root}${siteOnly ? ZHIHU_SITE_SEARCH_PATH : ZHIHU_GLOBAL_SEARCH_PATH}`);
    url.searchParams.set('Query', request.query);
    url.searchParams.set(
        'Count',
        String(
            Math.min(
                resultLimit(request, siteOnly ? ZHIHU_SITE_SEARCH_MAX : ZHIHU_GLOBAL_SEARCH_MAX),
                siteOnly ? ZHIHU_SITE_SEARCH_MAX : ZHIHU_GLOBAL_SEARCH_MAX
            )
        )
    );
    if (!siteOnly) {
        url.searchParams.set('SearchDB', searchSource(request) === 'news' ? 'realtime' : 'all');
        const filter = buildZhihuFilter(request);
        if (filter) {
            url.searchParams.set('Filter', filter);
        }
    }
    setSearchParams(url, options);
    return { url, siteOnly };
}

/** 官方 Filter 语法：`host=="a" OR host=="b" AND publish_time>=秒级时间戳`。 */
export function buildZhihuFilter(request: WebSearchRequest): string | undefined {
    const clauses: string[] = [];
    const domains = request.domains.map((domain) => domain.trim()).filter(Boolean);
    if (domains.length > 0) {
        const hosts = domains.map((domain) => `host==${JSON.stringify(domain)}`).join(' OR ');
        clauses.push(
            domains.length > 1 && (request.recencyDays || request.excludeDomains.length)
                ? `(${hosts})`
                : hosts
        );
    }
    request.excludeDomains.forEach((domain) => clauses.push(`host!=${JSON.stringify(domain)}`));

    const after = recencyStartDate(request.recencyDays);
    if (after) {
        clauses.push(`publish_time>=${Math.floor(Date.parse(after) / 1000)}`);
    }

    return clauses.length > 0 ? clauses.join(' AND ') : undefined;
}

/** ContentText 用 `<em>` 高亮命中词，卡片和模型都不需要这层标记。 */
export function stripZhihuHighlight(value: string): string {
    return value
        .replace(/<\/?[a-zA-Z][^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function toZhihuResult(item: unknown): WebSearchResult | null {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
    }

    const record = item as Record<string, unknown>;
    const title = normalizeOptionalString(record.Title);
    const url = normalizeOptionalString(record.Url);
    if (!title || !url || !/^https?:\/\//i.test(url)) {
        return null;
    }

    const editTime = typeof record.EditTime === 'number' ? record.EditTime : undefined;
    const authority = Number(record.AuthorityLevel);

    return {
        title,
        url,
        snippet: normalizeOptionalString(
            typeof record.ContentText === 'string'
                ? stripZhihuHighlight(record.ContentText)
                : undefined
        ),
        source: 'Zhihu',
        publishedAt: editTime ? new Date(editTime * 1000).toISOString() : undefined,
        score: typeof record.RankingScore === 'number' ? record.RankingScore : undefined,
        authority: Number.isFinite(authority) ? authority : undefined,
        details: resultDetails(record, [
            'ContentType',
            'AuthorName',
            'AuthorBadgeText',
            'VoteUpCount',
            'CommentCount',
            'CommentInfoList',
        ]),
    };
}

interface ZhihuPayload {
    Code?: unknown;
    Message?: unknown;
    Data?: { Items?: unknown };
}

export function readZhihuItems(payload: unknown): unknown[] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return [];
    }
    const parsed = payload as ZhihuPayload;
    if (parsed.Code !== 0 && parsed.Code !== '0') {
        throw new Error(
            `Zhihu search failed: ${String(parsed.Message ?? 'unknown error')} (code ${String(parsed.Code)})`
        );
    }
    const items = parsed.Data?.Items;
    return Array.isArray(items) ? items : [];
}

export const zhihuAdapter = createSearchProviderAdapter({
    id: 'zhihu',
    async search({ request, settings, signal, fetchJson }) {
        const apiKey = settings.providers.zhihu.apiKey.trim();
        if (!apiKey) {
            throw new Error('Zhihu search needs an Access Secret. Enter one in Search settings.');
        }

        const { url } = buildZhihuSearchUrl(request, settings.providers.zhihu.endpoint);
        const payload = await fetchJson(url, signal, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                // 服务端会校验时间戳，允许 ±10 分钟，取秒级即可。
                'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
                'Content-Type': 'application/json',
            },
        });

        return readZhihuItems(payload)
            .map(toZhihuResult)
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
