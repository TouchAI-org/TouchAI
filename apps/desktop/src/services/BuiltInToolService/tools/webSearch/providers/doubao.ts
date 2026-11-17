import { normalizeOptionalString } from '@/utils/text';

import type { WebSearchResult } from '../helper';
import { nativeSearchOptions, recencyStartDate, resultDetails, resultLimit } from './common';
import { createSearchProviderAdapter } from './define';

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function toDoubaoResult(item: unknown, includeContent: boolean): WebSearchResult | null {
    const row = record(item);
    const image = record(row.Image);
    const host = record(row.HostInfo);
    const info = record(row.DocumentInfo);
    const url =
        normalizeOptionalString(row.Url) ??
        normalizeOptionalString(image.Url) ??
        normalizeOptionalString(row.ImageUrl);
    if (!url || !/^https?:\/\//i.test(url)) return null;
    const snippets = Array.isArray(row.Snippet) ? row.Snippet : [];
    return {
        title: normalizeOptionalString(row.Title) ?? url,
        url,
        source:
            normalizeOptionalString(row.SiteName) ??
            normalizeOptionalString(host.Hostname) ??
            'Doubao',
        snippet:
            normalizeOptionalString(row.Summary) ??
            normalizeOptionalString(row.Snippet) ??
            (snippets
                .map((value) => normalizeOptionalString(record(value).Text))
                .filter(Boolean)
                .join('\n') ||
                undefined),
        content: includeContent ? normalizeOptionalString(row.Content) : undefined,
        publishedAt:
            normalizeOptionalString(row.PublishTime) ?? normalizeOptionalString(info.PublishTime),
        favicon: normalizeOptionalString(row.LogoUrl) ?? normalizeOptionalString(host.IconUrl),
        score: typeof row.RankScore === 'number' ? row.RankScore : undefined,
        // Doubao's authority scale runs in the opposite direction to DeepSeek's.
        details: resultDetails(
            {
                ...row,
                HostInfo: row.HostInfo,
                imageSnippets: snippets.filter((value) => record(value).Type === 'image'),
            },
            [
                'AuthInfoLevel',
                'AuthInfoDes',
                'InlineImages',
                'AuthorInfo',
                'RuyiInfo',
                'Image',
                'ImageUrl',
                'HostInfo',
                'DocumentInfo',
                ...(snippets.length ? ['imageSnippets'] : []),
            ]
        ),
    };
}

export const doubaoAdapter = createSearchProviderAdapter({
    id: 'doubao',
    async search({ request, settings, signal, fetchJson }) {
        const { edition = 'custom', ...options } = nativeSearchOptions(request, 'doubao');
        if (edition !== 'custom' && edition !== 'global')
            throw new Error('Doubao edition must be custom or global.');
        const global = edition === 'global';
        const searchType = options.SearchType ?? 'web';
        if (
            !(global ? ['web', 'image', 'visual'] : ['web', 'image']).includes(String(searchType))
        ) {
            throw new Error('Unsupported Doubao SearchType for this edition.');
        }
        if (
            (global || searchType !== 'web') &&
            (request.domains.length || request.excludeDomains.length || request.recencyDays)
        ) {
            throw new Error(
                'Doubao site/date filters require Custom web search; select edition=custom and SearchType=web.'
            );
        }
        if (request.domains.length > 20 || request.excludeDomains.length > 5) {
            throw new Error(
                'Doubao Custom accepts at most 20 included sites and 5 excluded hosts.'
            );
        }
        const body: Record<string, unknown> = {
            Query: request.query,
            SearchType: searchType,
            ...(global
                ? { DocCount: resultLimit(request, 20) }
                : { Count: resultLimit(request, searchType === 'image' ? 5 : 50) }),
            ...(!global && searchType === 'web'
                ? {
                      Filter: {
                          ...(request.domains.length ? { Sites: request.domains.join('|') } : {}),
                          ...(request.excludeDomains.length
                              ? { BlockHosts: request.excludeDomains.join('|') }
                              : {}),
                          ...record(options.Filter),
                      },
                      ...(request.includeContent ? { ContentFormats: 'markdown' } : {}),
                      ...(request.recencyDays
                          ? {
                                TimeRange: `${recencyStartDate(request.recencyDays)?.slice(0, 10)}..${new Date().toISOString().slice(0, 10)}`,
                            }
                          : {}),
                  }
                : {}),
            ...options,
        };
        if (typeof body.Query !== 'string' || [...body.Query].length > 100) {
            throw new Error(
                'Doubao Query accepts at most 100 characters; shorten it or split the search.'
            );
        }
        const config = settings.providers.doubao;
        const root =
            config.endpoint
                .trim()
                .replace(/\/+$/, '')
                .replace(/\/search_api(?:\/(?:web_search|global_search))?$/, '') ||
            'https://open.feedcoopapi.com';
        const payload = record(
            await fetchJson(
                new URL(`${root}/search_api/${global ? 'global_search' : 'web_search'}`),
                signal,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${config.apiKey.trim()}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(body),
                }
            )
        );
        const error = record(record(payload.ResponseMetadata).Error);
        const result = record(payload.Result);
        if (
            Object.keys(error).length ||
            (result.ErrorCode !== undefined && result.ErrorCode !== 0)
        ) {
            throw new Error(
                `Doubao search failed (${String(error.Code ?? result.ErrorCode)}): ${String(error.Message ?? result.ErrorMsg ?? 'unknown error')}`
            );
        }
        const items = global
            ? result.Documents
            : searchType === 'image'
              ? result.ImageResults
              : result.WebResults;
        const results = (Array.isArray(items) ? items : [])
            .map((item) => toDoubaoResult(item, request.includeContent === true))
            .filter((item): item is WebSearchResult => item !== null);
        if (results[0] && Array.isArray(result.CardResults) && result.CardResults.length) {
            results[0].details = { ...results[0].details, CardResults: result.CardResults };
        }
        return results;
    },
});
