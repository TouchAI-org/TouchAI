import { normalizeOptionalString } from '@/utils/text';

import { decodeOpenAlexAbstract, type WebSearchResult } from '../helper';
import { resultLimit } from './common';
import { createSearchProviderAdapter } from './define';

export const openAlexAdapter = createSearchProviderAdapter({
    id: 'openalex',
    async search({ request, signal, fetchJson }) {
        const url = new URL('https://api.openalex.org/works');
        url.searchParams.set('search', request.query);
        url.searchParams.set('per-page', String(resultLimit(request)));

        const payload = await fetchJson(url, signal);
        const results =
            payload && typeof payload === 'object'
                ? (payload as { results?: unknown }).results
                : null;
        if (!Array.isArray(results)) {
            return [];
        }

        return results
            .map((item): WebSearchResult | null => {
                if (!item || typeof item !== 'object') {
                    return null;
                }
                const record = item as Record<string, unknown>;
                const primaryLocation =
                    record.primary_location && typeof record.primary_location === 'object'
                        ? (record.primary_location as Record<string, unknown>)
                        : {};
                const title = normalizeOptionalString(record.display_name);
                const url =
                    normalizeOptionalString(primaryLocation.landing_page_url) ??
                    normalizeOptionalString(record.id);
                if (!title || !url) {
                    return null;
                }

                const year =
                    typeof record.publication_year === 'number'
                        ? `Publication year: ${record.publication_year}. `
                        : '';
                return {
                    title,
                    url,
                    snippet:
                        `${year}${decodeOpenAlexAbstract(record.abstract_inverted_index) ?? ''}`.trim(),
                    source: 'OpenAlex',
                };
            })
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
