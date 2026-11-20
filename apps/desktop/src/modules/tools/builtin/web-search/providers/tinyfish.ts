import type { WebSearchResult } from '../helper';
import {
    nativeSearchOptions,
    readResultItems,
    recencyStartDate,
    resultDetails,
    resultFromGenericItem,
    searchSource,
    setSearchParams,
} from './common';
import { createSearchProviderAdapter } from './define';
import { tinyfishEndpoint } from './tinyfish-endpoint';

export const tinyfishAdapter = createSearchProviderAdapter({
    id: 'tinyfish',
    async search({ request, settings, signal, fetchJson }) {
        const config = settings.providers.tinyfish;
        const url = tinyfishEndpoint(config.endpoint, 'search');
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
        // 官方文档：domain_type=research_paper 不支持 recency_minutes / after_date / before_date，
        // 时间窗口改用 pub_year_min 表达；原生 pub_year_min 仍然优先。
        if (params.domain_type === 'research_paper') {
            delete params.recency_minutes;
            const cutoffYear = recencyStartDate(request.recencyDays)?.slice(0, 4);
            if (params.pub_year_min === undefined && cutoffYear) {
                params.pub_year_min = cutoffYear;
            }
        }
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
