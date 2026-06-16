import type { WebSearchResult } from '../helper';
import { readResultItems, recencyStartDate, resultFromGenericItem, resultLimit } from './common';
import { createSearchProviderAdapter } from './define';

export const exaAdapter = createSearchProviderAdapter({
    id: 'exa',
    async search({ request, settings, signal, fetchJson }) {
        const body: Record<string, unknown> = {
            query: request.query,
            type: 'auto',
            numResults: resultLimit(request),
        };
        if (request.domains.length > 0) {
            body.includeDomains = request.domains;
        }
        const startPublishedDate = recencyStartDate(request.recencyDays);
        if (startPublishedDate) {
            body.startPublishedDate = startPublishedDate;
        }
        if (request.intent === 'academic') {
            body.category = 'research paper';
        } else if (request.intent === 'technical') {
            body.category = 'github';
        } else if (request.intent === 'news') {
            body.category = 'news';
        }

        const payload = await fetchJson(new URL('https://api.exa.ai/search'), signal, {
            method: 'POST',
            headers: {
                'x-api-key': settings.providers.exa.apiKey.trim(),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        return readResultItems(payload)
            .map((item) => resultFromGenericItem(item, 'Exa'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
