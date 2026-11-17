import type { WebSearchResult } from '../helper';
import {
    nativeSearchOptions,
    readResultItems,
    resultDetails,
    resultFromGenericItem,
    searchSource,
    setSearchParams,
} from './common';
import { createSearchProviderAdapter } from './define';

export const tinyfishAdapter = createSearchProviderAdapter({
    id: 'tinyfish',
    async search({ request, settings, signal, fetchJson }) {
        const config = settings.providers.tinyfish;
        const root = config.endpoint.trim().replace(/\/+$/, '');
        const url = new URL(
            root
                ? `${root.replace(/\/v1(?:\/search)?$/, '')}/v1/search`
                : 'https://api.search.tinyfish.ai/'
        );
        const options = nativeSearchOptions(request, 'tinyfish');
        const source = searchSource(request);
        const params: Record<string, unknown> = {
            query: request.query,
            ...(request.language !== 'any' ? { language: request.language } : {}),
            ...(request.domains.length ? { include_domains: request.domains.join(',') } : {}),
            ...(request.excludeDomains.length
                ? { exclude_domains: request.excludeDomains.join(',') }
                : {}),
            ...(source === 'news'
                ? { domain_type: 'news' }
                : source === 'academic'
                  ? { domain_type: 'research_paper' }
                  : {}),
            ...(request.recencyDays &&
            options.after_date === undefined &&
            options.before_date === undefined
                ? { recency_minutes: request.recencyDays * 1440 }
                : {}),
            ...options,
        };
        if (
            params.recency_minutes !== undefined &&
            (params.after_date !== undefined || params.before_date !== undefined)
        ) {
            throw new Error(
                'TinyFish recency_minutes cannot be combined with after_date or before_date.'
            );
        }
        for (const key of ['pub_year_min', 'pub_year_max']) {
            if (params[key] !== undefined) params[key] = String(params[key]).padStart(4, '0');
        }
        setSearchParams(url, params);
        const payload = await fetchJson(url, signal, {
            headers: { 'X-API-Key': config.apiKey.trim() },
        });
        return readResultItems(payload).flatMap((item): WebSearchResult[] => {
            const result = resultFromGenericItem(item, 'TinyFish');
            if (!result) return [];
            const row = item as Record<string, unknown>;
            return [
                {
                    ...result,
                    publishedAt: typeof row.date === 'string' ? row.date : undefined,
                    details: resultDetails(row, [
                        'publisher',
                        'authors',
                        'venue',
                        'year',
                        'cited_by_count',
                        'pdf_url',
                    ]),
                },
            ];
        });
    },
});
