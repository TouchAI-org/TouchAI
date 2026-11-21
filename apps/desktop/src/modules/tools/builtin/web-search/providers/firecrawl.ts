import type { WebSearchResult } from '../helper';
import {
    nativeSearchOptions,
    providerEndpointUrl,
    queryWithDomains,
    resultFromGenericItem,
    resultLimit,
    searchSource,
} from './common';
import { createSearchProviderAdapter } from './define';

function readFirecrawlResults(payload: unknown): unknown[] {
    if (!payload || typeof payload !== 'object') {
        return [];
    }
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) {
        return data;
    }
    if (data && typeof data === 'object') {
        const record = data as Record<string, unknown>;
        return ['web', 'news', 'images'].flatMap((key) =>
            Array.isArray(record[key]) ? record[key] : []
        );
    }
    return [];
}

/**
 * Firecrawl 的 `/v2/search` 支持无 key 匿名调用（官方文档说明有匿名限流），
 * 配置 API key 后额度更高。无 key 时必须「省略」Authorization 头。
 *
 * 注意：keyless 档按出口 IP 判定，VPN/代理出口可能被 403 拒绝。
 */
export const firecrawlAdapter = createSearchProviderAdapter({
    id: 'firecrawl',
    async search({ request, settings, signal, fetchJson }) {
        const apiKey = settings.providers.firecrawl.apiKey.trim();
        const body: Record<string, unknown> = {
            query: queryWithDomains(request),
            limit: resultLimit(request, 100),
            sources: searchSource(request) === 'news' ? ['web', 'news'] : ['web'],
            ...(request.includeContent ? { scrapeOptions: { formats: ['markdown'] } } : {}),
            ...(request.language !== 'any' ? { lang: request.language } : {}),
        };
        if (request.recencyDays) {
            body.tbs = `qdr:${request.recencyDays <= 1 ? 'd' : request.recencyDays <= 7 ? 'w' : request.recencyDays <= 31 ? 'm' : 'y'}`;
        }
        Object.assign(body, nativeSearchOptions(request, 'firecrawl'));

        const payload = await fetchJson(
            providerEndpointUrl(
                settings.providers.firecrawl.endpoint,
                'https://api.firecrawl.dev',
                '/v2/search'
            ),
            signal,
            {
                method: 'POST',
                headers: {
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }
        );
        return readFirecrawlResults(payload)
            .map((item) => resultFromGenericItem(item, 'Firecrawl'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
