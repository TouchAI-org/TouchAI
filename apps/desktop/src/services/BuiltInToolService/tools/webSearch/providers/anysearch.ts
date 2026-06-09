import type { WebSearchResult } from '../helper';
import { readResultItems, resultFromGenericItem, resultLimit } from './common';
import { createSearchProviderAdapter } from './define';

export const anySearchAdapter = createSearchProviderAdapter({
    id: 'anysearch',
    async search({ request, settings, signal, fetchJson }) {
        const url = new URL('https://api.anysearch.com/v1/search');
        const apiKey = settings.providers.anysearch.apiKey.trim();
        const payload = await fetchJson(url, signal, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
                query: request.query,
                max_results: resultLimit(request),
                ...(request.domains.length > 0 ? { domains: request.domains } : {}),
                ...(request.intent === 'news' ? { content_types: ['news', 'web'] } : {}),
                ...(request.recencyDays
                    ? {
                          constraint: {
                              freshness:
                                  request.recencyDays <= 1
                                      ? 'day'
                                      : request.recencyDays <= 7
                                        ? 'week'
                                        : request.recencyDays <= 31
                                          ? 'month'
                                          : 'year',
                          },
                      }
                    : {}),
            }),
        });

        return readResultItems(payload)
            .map((item) => resultFromGenericItem(item, 'AnySearch'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
