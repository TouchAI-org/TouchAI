import type { WebSearchResult } from '../helper';
import { readResultItems, resultFromGenericItem, resultLimit } from './common';
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
        url.searchParams.set('q', request.query);
        url.searchParams.set('format', 'json');
        url.searchParams.set('language', 'auto');
        url.searchParams.set('safesearch', '0');

        const payload = await fetchJson(url, signal);
        return readResultItems(payload)
            .slice(0, resultLimit(request))
            .map((item) => resultFromGenericItem(item, 'SearXNG'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
