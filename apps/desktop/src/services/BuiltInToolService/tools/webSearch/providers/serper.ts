import type { WebSearchResult } from '../helper';
import {
    nativeSearchOptions,
    queryWithDomains,
    resultDetails,
    resultFromGenericItem,
    resultLimit,
    searchSource,
} from './common';
import { createSearchProviderAdapter } from './define';

export const serperAdapter = createSearchProviderAdapter({
    id: 'serper',
    async search({ request, settings, signal, fetchJson }) {
        const { searchType = searchSource(request) === 'news' ? 'news' : 'search', ...options } =
            nativeSearchOptions(request, 'serper');
        if (
            ![
                'search',
                'news',
                'images',
                'videos',
                'places',
                'shopping',
                'scholar',
                'patents',
            ].includes(String(searchType))
        ) {
            throw new Error(
                'Unsupported Serper searchType. Use search, news, images, videos, places, shopping, scholar or patents.'
            );
        }
        const config = settings.providers.serper;
        const root = config.endpoint.trim().replace(/\/+$/, '') || 'https://google.serper.dev';
        const base = new URL(root);
        const serperUrl = base.pathname === '/' ? new URL(`${root}/${String(searchType)}`) : base;
        const payload = (await fetchJson(serperUrl, signal, {
            method: 'POST',
            headers: { 'X-API-KEY': config.apiKey.trim(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                q: queryWithDomains(request),
                num: resultLimit(request, 100),
                ...(request.language !== 'any'
                    ? { hl: request.language === 'zh' ? 'zh-cn' : 'en' }
                    : {}),
                ...(request.recencyDays ? { tbs: `qdr:d${request.recencyDays}` } : {}),
                ...options,
            }),
        })) as Record<string, unknown> | null;
        if (
            payload?.error ||
            (typeof payload?.statusCode === 'number' && payload.statusCode >= 400)
        ) {
            throw new Error(
                `Serper search failed: ${String(payload.error ?? payload.message ?? payload.statusCode)}`
            );
        }
        const key = searchType === 'search' ? 'organic' : String(searchType);
        const rows = payload?.[key];
        const results = (Array.isArray(rows) ? rows : []).flatMap((item): WebSearchResult[] => {
            const result = resultFromGenericItem(item, 'Serper');
            if (!result) return [];
            const row = item as Record<string, unknown>;
            return [
                {
                    ...result,
                    publishedAt: typeof row.date === 'string' ? row.date : undefined,
                    details: resultDetails(row, [
                        'imageUrl',
                        'imageWidth',
                        'imageHeight',
                        'thumbnailUrl',
                        'duration',
                        'price',
                        'rating',
                        'ratingCount',
                        'sitelinks',
                        'attributes',
                    ]),
                },
            ];
        });
        if (results[0] && payload) {
            const extras = resultDetails(payload, [
                'answerBox',
                'knowledgeGraph',
                'peopleAlsoAsk',
                'relatedSearches',
            ]);
            if (extras) results[0].details = { ...results[0].details, ...extras };
        }
        return results;
    },
});
