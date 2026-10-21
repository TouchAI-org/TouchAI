import type { WebSearchResult } from '../helper';
import { readResultItems, resultFromGenericItem, resultLimit } from './common';
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
            topic: request.intent === 'news' ? 'news' : 'general',
            search_depth: 'basic',
            max_results: resultLimit(request),
            include_answer: false,
            include_raw_content: false,
        };
        if (request.domains.length > 0) {
            body.include_domains = request.domains;
        }

        const payload = await fetchJson(new URL('https://api.tavily.com/search'), signal, {
            method: 'POST',
            headers: {
                ...(apiKey
                    ? { Authorization: `Bearer ${apiKey}` }
                    : { 'x-tavily-access-mode': 'keyless' }),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        return readResultItems(payload)
            .map((item) => resultFromGenericItem(item, 'Tavily'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
