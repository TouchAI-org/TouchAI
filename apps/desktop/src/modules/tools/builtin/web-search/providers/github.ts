import { normalizeOptionalString } from '@/utils/text';

import type { WebSearchResult } from '../helper';
import { resultLimit } from './common';
import { createSearchProviderAdapter } from './define';

export const githubAdapter = createSearchProviderAdapter({
    id: 'github',
    async search({ request, signal, fetchJson }) {
        const url = new URL('https://api.github.com/search/repositories');
        url.searchParams.set('q', request.query);
        url.searchParams.set('per_page', String(resultLimit(request)));

        const payload = await fetchJson(url, signal);
        const items =
            payload && typeof payload === 'object' ? (payload as { items?: unknown }).items : null;
        if (!Array.isArray(items)) {
            return [];
        }

        return items
            .map((item): WebSearchResult | null => {
                if (!item || typeof item !== 'object') {
                    return null;
                }
                const record = item as Record<string, unknown>;
                const title = normalizeOptionalString(record.full_name);
                const url = normalizeOptionalString(record.html_url);
                if (!title || !url) {
                    return null;
                }

                const description = normalizeOptionalString(record.description) ?? '';
                const stars =
                    typeof record.stargazers_count === 'number'
                        ? `Stars: ${record.stargazers_count}. `
                        : '';
                return {
                    title,
                    url,
                    snippet: `${stars}${description}`.trim(),
                    source: 'GitHub',
                };
            })
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
