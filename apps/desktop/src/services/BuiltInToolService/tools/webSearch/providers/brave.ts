import type { WebSearchResult } from '../helper';
import { resultFromGenericItem, resultLimit } from './common';
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
        const url = new URL('https://api.search.brave.com/res/v1/web/search');
        url.searchParams.set('q', request.query);
        url.searchParams.set('count', String(resultLimit(request)));
        const freshness = braveFreshness(request.recencyDays);
        if (freshness) {
            url.searchParams.set('freshness', freshness);
        }

        const payload = await fetchJson(url, signal, {
            headers: {
                'X-Subscription-Token': settings.providers.brave.apiKey.trim(),
            },
        });
        const webResults =
            payload && typeof payload === 'object'
                ? (payload as { web?: { results?: unknown } }).web?.results
                : null;
        if (!Array.isArray(webResults)) {
            return [];
        }
        return webResults
            .map((item) => resultFromGenericItem(item, 'Brave'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
