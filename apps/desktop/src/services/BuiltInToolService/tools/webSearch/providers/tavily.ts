import type { WebSearchResult } from '../helper';
import { readResultItems, resultFromGenericItem, resultLimit } from './common';
import { createSearchProviderAdapter } from './define';

export const tavilyAdapter = createSearchProviderAdapter({
    id: 'tavily',
    async search({ request, settings, signal, fetchJson }) {
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
                Authorization: `Bearer ${settings.providers.tavily.apiKey.trim()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        return readResultItems(payload)
            .map((item) => resultFromGenericItem(item, 'Tavily'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
