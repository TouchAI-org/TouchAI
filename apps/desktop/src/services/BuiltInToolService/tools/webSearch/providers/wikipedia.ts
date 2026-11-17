import type { WebSearchResult } from '../helper';
import { nativeSearchOptions, resultLimit, setSearchParams } from './common';
import { createSearchProviderAdapter } from './define';

export const wikipediaAdapter = createSearchProviderAdapter({
    id: 'wikipedia',
    async search({ request, signal, fetchJson }) {
        const url = new URL(
            request.language === 'zh'
                ? 'https://zh.wikipedia.org/w/api.php'
                : 'https://en.wikipedia.org/w/api.php'
        );
        url.searchParams.set('action', 'opensearch');
        url.searchParams.set('search', request.query);
        url.searchParams.set('limit', String(resultLimit(request, 500)));
        url.searchParams.set('namespace', '0');
        url.searchParams.set('format', 'json');
        url.searchParams.set('origin', '*');
        setSearchParams(url, nativeSearchOptions(request, 'wikipedia'));
        url.searchParams.set('action', 'opensearch');
        url.searchParams.set('format', 'json');

        const payload = await fetchJson(url, signal);
        if (!Array.isArray(payload)) {
            return [];
        }

        const titles = Array.isArray(payload[1]) ? payload[1] : [];
        const snippets = Array.isArray(payload[2]) ? payload[2] : [];
        const urls = Array.isArray(payload[3]) ? payload[3] : [];
        return titles
            .map((title, index): WebSearchResult | null => {
                const resultUrl = urls[index];
                if (typeof title !== 'string' || typeof resultUrl !== 'string') {
                    return null;
                }
                return {
                    title,
                    url: resultUrl,
                    snippet: typeof snippets[index] === 'string' ? snippets[index] : undefined,
                    source: 'Wikipedia',
                };
            })
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
