import type { WebSearchResult } from '../helper';
import { resultFromGenericItem, resultLimit } from './common';
import { createSearchProviderAdapter } from './define';

function readFirecrawlResults(payload: unknown): unknown[] {
    if (!payload || typeof payload !== 'object') {
        return [];
    }
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) {
        return data;
    }
    if (data && typeof data === 'object') {
        const record = data as Record<string, unknown>;
        return ['web', 'news', 'images'].flatMap((key) =>
            Array.isArray(record[key]) ? record[key] : []
        );
    }
    return [];
}

export const firecrawlAdapter = createSearchProviderAdapter({
    id: 'firecrawl',
    async search({ request, settings, signal, fetchJson }) {
        const body: Record<string, unknown> = {
            query: request.query,
            limit: resultLimit(request),
            sources: request.intent === 'news' ? ['web', 'news'] : ['web'],
        };
        if (request.recencyDays) {
            body.tbs = `qdr:${request.recencyDays <= 1 ? 'd' : request.recencyDays <= 7 ? 'w' : request.recencyDays <= 31 ? 'm' : 'y'}`;
        }

        const payload = await fetchJson(new URL('https://api.firecrawl.dev/v2/search'), signal, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${settings.providers.firecrawl.apiKey.trim()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        return readFirecrawlResults(payload)
            .map((item) => resultFromGenericItem(item, 'Firecrawl'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
