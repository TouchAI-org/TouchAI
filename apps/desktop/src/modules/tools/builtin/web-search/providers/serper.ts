import { normalizeOptionalString } from '@/utils/text';

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

/** Serper Places 用 `website` 表示链接；没有网站时退回 Google Maps 查询地址。 */
function withPlaceUrl(row: Record<string, unknown>): Record<string, unknown> {
    const website = normalizeOptionalString(row.website);
    if (website) return { ...row, url: website };
    const latitude = typeof row.latitude === 'number' ? row.latitude : undefined;
    const longitude = typeof row.longitude === 'number' ? row.longitude : undefined;
    const query =
        latitude !== undefined && longitude !== undefined
            ? `${latitude},${longitude}`
            : [normalizeOptionalString(row.title), normalizeOptionalString(row.address)]
                  .filter(Boolean)
                  .join(' ');
    return query
        ? {
              ...row,
              url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
          }
        : row;
}

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
        // search / scholar / patents 的结果数组都放在 organic 下。
        const key = ['search', 'scholar', 'patents'].includes(String(searchType))
            ? 'organic'
            : String(searchType);
        const rows = payload?.[key];
        const results = (Array.isArray(rows) ? rows : []).flatMap((item): WebSearchResult[] => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
            const row = item as Record<string, unknown>;
            const result = resultFromGenericItem(
                searchType === 'places' ? withPlaceUrl(row) : row,
                'Serper'
            );
            if (!result) return [];
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
