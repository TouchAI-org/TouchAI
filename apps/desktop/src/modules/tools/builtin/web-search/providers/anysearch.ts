import type { WebSearchResult } from '../helper';
import {
    nativeSearchOptions,
    preserveSearchExtras,
    queryWithDomains,
    readResultItems,
    resultFromGenericItem,
    resultLimit,
    searchSource,
} from './common';
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
                query: queryWithDomains({ ...request, domains: [] }),
                max_results: resultLimit(request),
                ...(request.domains.length > 0 ? { domains: request.domains } : {}),
                ...(searchSource(request) === 'news' ? { content_types: ['news', 'web'] } : {}),
                ...(request.recencyDays !== undefined
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
                ...nativeSearchOptions(request, 'anysearch'),
            }),
        });

        return preserveSearchExtras(
            readResultItems(payload)
                .map((item) => resultFromGenericItem(item, 'AnySearch'))
                .filter((result): result is WebSearchResult => Boolean(result)),
            payload
        );
    },
});
