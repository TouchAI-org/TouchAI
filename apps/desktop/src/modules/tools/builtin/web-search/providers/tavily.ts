import type { WebSearchResult } from '../helper';
import {
    nativeSearchOptions,
    preserveSearchExtras,
    providerEndpointUrl,
    readResultItems,
    recencyStartDate,
    resultFromGenericItem,
    resultLimit,
    searchSource,
} from './common';
import { createSearchProviderAdapter } from './define';

/**
 * Tavily 提供 keyless 匿名额度：不带 `Authorization`、改发
 * `x-tavily-access-mode: keyless` 即可免费查询。配置 API key 后走账号额度。
 *
 * 注意：无 key 时必须「省略」Authorization 头，发空 `Bearer ` 会被判为无效凭据。
 */
export const tavilyAdapter = createSearchProviderAdapter({
    id: 'tavily',
    async search({ request, settings, signal, fetchJson }) {
        const apiKey = settings.providers.tavily.apiKey.trim();
        const body: Record<string, unknown> = {
            query: request.query,
            topic: searchSource(request) === 'news' ? 'news' : 'general',
            search_depth: request.mode === 'deep' ? 'advanced' : 'basic',
            max_results: resultLimit(request, 20),
            include_answer: false,
            include_raw_content: request.includeContent === true,
        };
        if (request.domains.length > 0) {
            body.include_domains = request.domains;
        }
        if (request.excludeDomains.length > 0) {
            body.exclude_domains = request.excludeDomains;
        }
        if (request.recencyDays !== undefined) {
            if (searchSource(request) === 'news') body.days = request.recencyDays;
            else body.start_date = recencyStartDate(request.recencyDays)?.slice(0, 10);
        }
        Object.assign(body, nativeSearchOptions(request, 'tavily'));

        const payload = await fetchJson(
            providerEndpointUrl(
                settings.providers.tavily.endpoint,
                'https://api.tavily.com',
                '/search'
            ),
            signal,
            {
                method: 'POST',
                headers: {
                    ...(apiKey
                        ? { Authorization: `Bearer ${apiKey}` }
                        : { 'x-tavily-access-mode': 'keyless' }),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }
        );
        return preserveSearchExtras(
            readResultItems(payload)
                .map((item) => resultFromGenericItem(item, 'Tavily'))
                .filter((result): result is WebSearchResult => Boolean(result)),
            payload
        );
    },
});
