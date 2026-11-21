import type { WebSearchResult } from '../helper';
import {
    nativeSearchOptions,
    queryWithDomains,
    readResultItems,
    resultFromGenericItem,
    searchSource,
    setSearchParams,
} from './common';
import { createSearchProviderAdapter } from './define';

function searxngSearchUrl(endpoint: string): URL {
    const base = new URL(endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
    return new URL('search', base);
}

export const searxngAdapter = createSearchProviderAdapter({
    id: 'searxng',
    async search({ request, settings, signal, fetchJson }) {
        const endpoint = settings.providers.searxng.endpoint.trim();
        if (!endpoint) {
            return [];
        }
        let url: URL;
        try {
            url = searxngSearchUrl(endpoint);
        } catch {
            return [];
        }
        url.searchParams.set('q', queryWithDomains(request));
        url.searchParams.set('format', 'json');
        url.searchParams.set('language', request.language === 'any' ? 'auto' : request.language);
        url.searchParams.set('safesearch', '0');
        if (searchSource(request) === 'news') url.searchParams.set('categories', 'news');
        if (request.recencyDays)
            url.searchParams.set(
                'time_range',
                request.recencyDays <= 1 ? 'day' : request.recencyDays <= 31 ? 'month' : 'year'
            );
        setSearchParams(url, nativeSearchOptions(request, 'searxng'));
        url.searchParams.set('format', 'json');

        const payload = await fetchJson(url, signal);
        return readResultItems(payload)
            .slice(0, request.maxResults > 0 ? request.maxResults : undefined)
            .map((item) => resultFromGenericItem(item, 'SearXNG'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
