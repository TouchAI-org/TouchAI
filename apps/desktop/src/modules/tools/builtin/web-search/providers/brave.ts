import type { WebSearchResult } from '../helper';
import {
    nativeSearchOptions,
    queryWithDomains,
    resultFromGenericItem,
    resultLimit,
    searchSource,
    setSearchParams,
} from './common';
import { createSearchProviderAdapter } from './define';

function braveFreshness(recencyDays: number | undefined): string | undefined {
    if (recencyDays === undefined) {
        return undefined;
    }
    if (recencyDays <= 1) {
        return 'pd';
    }
    if (recencyDays <= 7) {
        return 'pw';
    }
    if (recencyDays <= 31) {
        return 'pm';
    }
    return 'py';
}

export const braveAdapter = createSearchProviderAdapter({
    id: 'brave',
    async search({ request, settings, signal, fetchJson }) {
        const { searchType = searchSource(request) === 'news' ? 'news' : 'web', ...options } =
            nativeSearchOptions(request, 'brave');
        if (!['web', 'news', 'images', 'videos'].includes(String(searchType)))
            throw new Error('Unsupported Brave searchType.');
        const url = new URL(`https://api.search.brave.com/res/v1/${String(searchType)}/search`);
        url.searchParams.set('q', queryWithDomains(request));
        if (searchType === 'web' || searchType === 'news') {
            url.searchParams.set('extra_snippets', 'true');
        }
        const pageSize = searchType === 'images' ? 200 : searchType === 'web' ? 20 : 50;
        url.searchParams.set('count', String(resultLimit(request, pageSize)));
        const freshness = braveFreshness(request.recencyDays);
        if (freshness) {
            url.searchParams.set('freshness', freshness);
        }
        if (request.language !== 'any')
            url.searchParams.set('search_lang', request.language === 'zh' ? 'zh-hans' : 'en');
        setSearchParams(url, options);

        const payload = await fetchJson(url, signal, {
            headers: {
                'X-Subscription-Token': settings.providers.brave.apiKey.trim(),
            },
        });
        const webResults =
            payload && typeof payload === 'object'
                ? ((payload as { web?: { results?: unknown }; results?: unknown }).web?.results ??
                  (payload as { results?: unknown }).results)
                : null;
        if (!Array.isArray(webResults)) {
            return [];
        }
        return webResults
            .map((item) => resultFromGenericItem(item, 'Brave'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
