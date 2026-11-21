import { normalizeOptionalString } from '@/utils/text';

import type { WebSearchResult } from '../helper';
import {
    nativeSearchOptions,
    queryWithDomains,
    resultDetails,
    searchSource,
    stripHtmlText,
} from './common';
import { createSearchProviderAdapter } from './define';
import { SearchProviderCapabilityError, WebSearchHttpError } from './types';

const YUANBAO_API_ROOT = 'https://api.wsa.cloud.tencent.com';
export const YUANBAO_SEARCH_PATH = '/SearchPro';

/** SearchPro accepts only these batch sizes; zero requests the largest batch. */
const YUANBAO_RESULT_COUNTS = [10, 20, 30, 40, 50] as const;

function yuanbaoResultCount(requested: number): number {
    if (requested <= 0) return 50;
    return YUANBAO_RESULT_COUNTS.find((count) => count >= requested) ?? 50;
}

export function buildYuanbaoSearchUrl(endpoint: string | null | undefined): URL {
    const trimmed = (endpoint ?? '').trim().replace(/\/+$/, '');
    const root = trimmed || YUANBAO_API_ROOT;
    return new URL(`${root}${YUANBAO_SEARCH_PATH}`);
}

/** `Freshness` 只接受 dN/mN/yN 与日期区间；这里把天数压进它支持的三档。 */
export function buildYuanbaoFreshness(recencyDays: number | undefined): string | undefined {
    if (recencyDays === undefined || !Number.isFinite(recencyDays) || recencyDays < 1) {
        return undefined;
    }
    if (recencyDays <= 30) {
        return `d${Math.max(1, Math.min(30, Math.trunc(recencyDays)))}`;
    }
    if (recencyDays <= 365) {
        return `m${Math.max(1, Math.min(12, Math.ceil(recencyDays / 30)))}`;
    }
    return `y${Math.max(1, Math.min(5, Math.ceil(recencyDays / 365)))}`;
}

export function buildYuanbaoIndustry(intent: string): string | undefined {
    if (intent === 'news') {
        return 'news';
    }
    if (intent === 'academic') {
        return 'acad';
    }
    if (intent === 'official') return 'gov';
    return undefined;
}

interface YuanbaoPage {
    title?: unknown;
    url?: unknown;
    site?: unknown;
    passage?: unknown;
    content?: unknown;
    date?: unknown;
    score?: unknown;
    authority_level?: unknown;
    favicon?: unknown;
    pics?: unknown;
    deeplinks?: unknown;
}

function parseYuanbaoPage(raw: unknown): YuanbaoPage | null {
    if (typeof raw !== 'string') {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        return parsed as YuanbaoPage;
    } catch {
        return null;
    }
}

export function toYuanbaoResult(page: YuanbaoPage): WebSearchResult | null {
    const title = normalizeOptionalString(page.title);
    const url = normalizeOptionalString(page.url);
    if (!title || !url || !/^https?:\/\//i.test(url)) {
        return null;
    }

    const snippet = normalizeOptionalString(
        typeof page.content === 'string' ? stripHtmlText(page.content) : undefined
    );
    const passage = normalizeOptionalString(
        typeof page.passage === 'string' ? stripHtmlText(page.passage) : undefined
    );
    const authority = Number(page.authority_level);

    return {
        title,
        url,
        snippet: snippet ?? passage,
        source: normalizeOptionalString(page.site) ?? 'Yuanbao',
        publishedAt: normalizeOptionalString(page.date),
        score: typeof page.score === 'number' ? page.score : undefined,
        authority: Number.isFinite(authority) ? authority : undefined,
        favicon: normalizeOptionalString(page.favicon) ?? undefined,
        details: resultDetails({ pics: page.pics, deeplinks: page.deeplinks }, [
            'pics',
            'deeplinks',
        ]),
    };
}

interface YuanbaoPayload {
    Response?: {
        Pages?: unknown;
        Error?: { Code?: unknown; Message?: unknown };
        Msg?: unknown;
    };
}

export function readYuanbaoPages(payload: unknown): WebSearchResult[] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return [];
    }
    const response = (payload as YuanbaoPayload).Response;
    if (!response) {
        return [];
    }
    if (response.Error) {
        const code = normalizeOptionalString(response.Error.Code);
        const message = `Yuanbao search failed: ${String(response.Error.Message ?? 'unknown error')} (code ${String(response.Error.Code)})`;
        // 官方把 RequestLimitExceeded 定义为频次/并发限制，按 429 交给自动回退换引擎。
        if (code === 'RequestLimitExceeded') throw new WebSearchHttpError(429, message);
        throw new Error(message);
    }
    const pages = Array.isArray(response.Pages) ? response.Pages : [];
    return pages
        .map((page) => {
            const parsed = parseYuanbaoPage(page);
            return parsed ? toYuanbaoResult(parsed) : null;
        })
        .filter((result): result is WebSearchResult => Boolean(result));
}

export const yuanbaoAdapter = createSearchProviderAdapter({
    id: 'yuanbao',
    async search({ request, settings, signal, fetchJson }) {
        const apiKey = settings.providers.yuanbao.apiKey.trim();
        if (!apiKey) {
            throw new Error(
                'Yuanbao search needs a service API key. Enter one in Search settings.'
            );
        }

        const url = buildYuanbaoSearchUrl(settings.providers.yuanbao.endpoint);
        const singleDomain = request.domains.length === 1 ? request.domains[0]?.trim() : '';
        if (request.excludeDomains.length > 5) {
            throw new SearchProviderCapabilityError(
                'Yuanbao Site accepts at most 5 excluded domains. Split the search into several calls or use a provider with a larger domain filter.'
            );
        }
        if (singleDomain && request.excludeDomains.length > 0) {
            throw new SearchProviderCapabilityError(
                'Yuanbao Site cannot combine an allowed site with excluded sites. Use one filter mode or separate searches.'
            );
        }
        const body: Record<string, unknown> = {
            Query: request.domains.length > 1 ? queryWithDomains(request) : request.query,
            Cnt: yuanbaoResultCount(request.maxResults),
            Mode: 2,
        };
        if (singleDomain) {
            body.Site = singleDomain;
        } else if (request.excludeDomains.length > 0) {
            body.Site = `exclude:${request.excludeDomains.join('|')}`;
        }
        const freshness = buildYuanbaoFreshness(request.recencyDays);
        if (freshness) {
            body.Freshness = freshness;
        }
        const industry = buildYuanbaoIndustry(searchSource(request));
        if (industry) {
            body.Industry = industry;
        }
        Object.assign(body, nativeSearchOptions(request, 'yuanbao'));

        const payload = await fetchJson(url, signal, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        return readYuanbaoPages(payload).slice(
            0,
            request.maxResults > 0 ? request.maxResults : undefined
        );
    },
});
