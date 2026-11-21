import { normalizeOptionalString } from '@/utils/text';

import type { WebSearchResult } from '../helper';
import {
    nativeSearchOptions,
    readResultItems,
    recencyStartDate,
    resultDetails,
    resultLimit,
    setSearchParams,
} from './common';
import { createSearchProviderAdapter } from './define';

export const semanticScholarAdapter = createSearchProviderAdapter({
    id: 'semantic_scholar',
    async search({ request, settings, signal, fetchJson }) {
        const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search');
        url.searchParams.set('query', request.query);
        url.searchParams.set('limit', String(resultLimit(request, 100)));
        url.searchParams.set('fields', 'title,url,abstract,year,authors');
        const after = recencyStartDate(request.recencyDays);
        if (after) url.searchParams.set('publicationDateOrYear', `${after.slice(0, 10)}:`);
        setSearchParams(url, nativeSearchOptions(request, 'semantic_scholar'));
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
                    details: resultDetails(record, [
                        'authors',
                        'citationCount',
                        'influentialCitationCount',
                        'openAccessPdf',
                        'fieldsOfStudy',
                        'tldr',
                        'externalIds',
                    ]),
                };
            })
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
