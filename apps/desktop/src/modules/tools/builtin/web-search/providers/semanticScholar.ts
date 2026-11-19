import { normalizeOptionalString } from '@/utils/text';

import type { WebSearchResult } from '../helper';
import { readResultItems, resultLimit } from './common';
import { createSearchProviderAdapter } from './define';

export const semanticScholarAdapter = createSearchProviderAdapter({
    id: 'semantic_scholar',
    async search({ request, settings, signal, fetchJson }) {
        const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search');
        url.searchParams.set('query', request.query);
        url.searchParams.set('limit', String(resultLimit(request)));
        url.searchParams.set('fields', 'title,url,abstract,year,authors');
        const apiKey = settings.providers.semantic_scholar.apiKey.trim();

        const payload = await fetchJson(url, signal, {
            headers: apiKey ? { 'x-api-key': apiKey } : {},
        });
        return readResultItems(payload)
            .map((item): WebSearchResult | null => {
                if (!item || typeof item !== 'object') {
                    return null;
                }
                const record = item as Record<string, unknown>;
                const title = normalizeOptionalString(record.title);
                const paperId = normalizeOptionalString(record.paperId);
                const urlValue =
                    normalizeOptionalString(record.url) ??
                    (paperId ? `https://www.semanticscholar.org/paper/${paperId}` : undefined);
                if (!title || !urlValue) {
                    return null;
                }
                const year = typeof record.year === 'number' ? `${record.year}. ` : '';
                return {
                    title,
                    url: urlValue,
                    snippet: `${year}${normalizeOptionalString(record.abstract) ?? ''}`.trim(),
                    source: 'Semantic Scholar',
                };
            })
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
