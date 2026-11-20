import { normalizeOptionalString } from '@/utils/text';

import type { WebSearchResult } from '../helper';
import { nativeSearchOptions, recencyStartDate, resultDetails, resultLimit } from './common';
import { createSearchProviderAdapter } from './define';

interface QianfanResponse {
    code?: string | number;
    message?: string;
    references?: Array<Record<string, unknown>>;
}

export const qianfanAdapter = createSearchProviderAdapter({
    id: 'qianfan',
    async search({ request, settings, signal, fetchJson }) {
        if (request.domains.length > 100 || request.excludeDomains.length > 20) {
            throw new Error('Qianfan accepts at most 100 included sites and 20 blocked websites.');
        }
        const options = nativeSearchOptions(request, 'qianfan');
        const body = {
            messages: [{ role: 'user', content: request.query }],
            search_source: 'baidu_search_v2',
            resource_type_filter: [{ type: 'web', top_k: resultLimit(request, 50) }],
            ...(request.domains.length || request.recencyDays
                ? {
                      search_filter: {
                          ...(request.domains.length ? { match: { site: request.domains } } : {}),
                          ...(request.recencyDays
                              ? {
                                    range: {
                                        page_time: {
                                            gte: recencyStartDate(request.recencyDays)?.slice(
                                                0,
                                                10
                                            ),
                                            lte: new Date().toISOString().slice(0, 10),
                                        },
                                    },
                                }
                              : {}),
                      },
                  }
                : {}),
            ...(request.excludeDomains.length ? { block_websites: request.excludeDomains } : {}),
            ...options,
        };
        const config = settings.providers.qianfan;
        const root =
            config.endpoint
                .trim()
                .replace(/\/+$/, '')
                .replace(/\/v2(?:\/ai_search\/web_search)?$/, '') || 'https://qianfan.baidubce.com';
        const payload = (await fetchJson(new URL(`${root}/v2/ai_search/web_search`), signal, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.apiKey.trim()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        })) as QianfanResponse | null;
        if (payload?.code !== undefined && payload.code !== 0 && payload.code !== '0') {
            throw new Error(
                `Qianfan search failed (${payload.code}): ${payload.message ?? 'unknown error'}`
            );
        }
        return (Array.isArray(payload?.references) ? payload.references : []).flatMap(
            (row): WebSearchResult[] => {
                const url = normalizeOptionalString(row.url);
                if (!url || !/^https?:\/\//i.test(url)) return [];
                return [
                    {
                        title:
                            normalizeOptionalString(row.title) ??
                            normalizeOptionalString(row.web_anchor) ??
                            url,
                        url,
                        source: normalizeOptionalString(row.website) ?? 'Qianfan',
                        snippet:
                            normalizeOptionalString(row.snippet) ??
                            normalizeOptionalString(row.content),
                        publishedAt: normalizeOptionalString(row.date),
                        favicon: normalizeOptionalString(row.icon),
                        score: typeof row.rerank_score === 'number' ? row.rerank_score : undefined,
                        details: resultDetails(row, [
                            'authority_score',
                            'type',
                            'image',
                            'video',
                            'aladdin',
                            'web_extensions',
                            'author_info',
                        ]),
                    },
                ];
            }
        );
    },
});
