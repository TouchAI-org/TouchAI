// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { cancelResponseBody, createTauriFetch } from '@/platform/http';
import { normalizeOptionalString } from '@/utils/text';

import {
    SEARCH_FETCH_PROVIDERS,
    type SearchFetchProvider,
    type SearchProviderConfig,
    type SearchSettingsConfig,
} from '../web-search/configuration';
import { tinyfishEndpoint } from '../web-search/providers/tinyfish-endpoint';
import type { createWebFetchOperations } from './operations';

/** 这些引擎的官方 API 都能直接返回一份可读正文，而不只是搜索结果摘要。 */
export const FETCH_CAPABLE_PROVIDERS = SEARCH_FETCH_PROVIDERS;
export type FetchCapableProvider = SearchFetchProvider;

export interface ProviderFetchPayload {
    provider: FetchCapableProvider;
    title?: string;
    content: string;
    finalUrl?: string;
    publishedAt?: string;
}

export function createProviderFetches({
    readResponseText,
}: Pick<ReturnType<typeof createWebFetchOperations>, 'readResponseText'>) {
    const tauriFetch = createTauriFetch();
    function rootOf(endpoint: string, fallback: string): string {
        const trimmed = endpoint.trim().replace(/\/+$/, '');
        return trimmed || fallback;
    }

    /**
     * 搜索配置里的 Serper 地址常填 `google.serper.dev` 或完整的 `/search` URL，
     * 抓取必须改走 scrape 路由，否则会把 `{ url, includeMarkdown }` 发给搜索接口。
     */
    function serperScrapeEndpoint(endpoint: string): string {
        const trimmed = endpoint.trim().replace(/\/+$/, '');
        if (!trimmed) return 'https://scrape.serper.dev';
        const url = new URL(trimmed);
        if (url.hostname === 'google.serper.dev') return 'https://scrape.serper.dev';
        url.pathname = url.pathname.replace(/\/(?:search|scrape)$/i, '');
        return url.toString().replace(/\/+$/, '');
    }

    async function readJson(
        response: Response,
        maxResponseBytes: number
    ): Promise<Record<string, unknown>> {
        const source = await readResponseText(response, Infinity, maxResponseBytes);
        if (source.sourceTruncated)
            throw new Error('Engine fetch response exceeded the byte limit.');
        const payload = JSON.parse(source.text) as unknown;
        return payload && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : {};
    }

    async function requireOk(response: Response, provider: string): Promise<void> {
        if (!response.ok) {
            await cancelResponseBody(response, `${provider} fetch response discarded`);
            throw new Error(
                `${provider} fetch failed: HTTP ${response.status} ${response.statusText}`.trim()
            );
        }
    }

    function recordOf(value: unknown): Record<string, unknown> {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
    }

    async function fetchAnySearch(
        url: string,
        config: SearchProviderConfig,
        signal: AbortSignal,
        maxResponseBytes: number
    ): Promise<ProviderFetchPayload> {
        const root = rootOf(config.endpoint, 'https://api.anysearch.com');
        const apiKey = config.apiKey.trim();
        const response = await tauriFetch(`${root}/v1/extract`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({ url }),
            signal,
        });
        await requireOk(response, 'AnySearch');
        const payload = await readJson(response, maxResponseBytes);
        const data = recordOf(payload.data);
        return {
            provider: 'anysearch',
            title: normalizeOptionalString(data.title) ?? normalizeOptionalString(payload.title),
            finalUrl: normalizeOptionalString(data.url),
            content:
                normalizeOptionalString(data.content) ??
                normalizeOptionalString(data.markdown) ??
                normalizeOptionalString(payload.content) ??
                '',
        };
    }

    async function fetchDeepSeek(
        url: string,
        config: SearchProviderConfig,
        signal: AbortSignal,
        maxResponseBytes: number
    ): Promise<ProviderFetchPayload> {
        const root = rootOf(config.endpoint, 'https://api.deepseek.com').replace(/\/v1$/i, '');
        const response = await tauriFetch(`${root}/v1/tools/fetch`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.apiKey.trim()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url }),
            signal,
        });
        await requireOk(response, 'DeepSeek');
        const payload = await readJson(response, maxResponseBytes);
        return {
            provider: 'deepseek',
            title: normalizeOptionalString(payload.title),
            content: normalizeOptionalString(payload.content) ?? '',
        };
    }

    async function fetchExa(
        url: string,
        config: SearchProviderConfig,
        signal: AbortSignal,
        maxResponseBytes: number
    ): Promise<ProviderFetchPayload> {
        if (!config.apiKey.trim()) {
            throw new Error(
                'Exa Fetch needs an API key. The keyless MCP endpoint only supports search.'
            );
        }
        const root = rootOf(config.endpoint, 'https://api.exa.ai').replace(/\/search$/, '');
        const response = await tauriFetch(`${root}/contents`, {
            method: 'POST',
            headers: { 'x-api-key': config.apiKey.trim(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                urls: [url],
                text: { maxCharacters: 50_000 },
                livecrawl: 'fallback',
            }),
            signal,
        });
        await requireOk(response, 'Exa');
        const payload = await readJson(response, maxResponseBytes);
        const first = recordOf(Array.isArray(payload.results) ? payload.results[0] : undefined);
        return {
            provider: 'exa',
            title: normalizeOptionalString(first.title),
            finalUrl: normalizeOptionalString(first.url),
            publishedAt: normalizeOptionalString(first.publishedDate),
            content: normalizeOptionalString(first.text) ?? '',
        };
    }

    async function fetchTavily(
        url: string,
        config: SearchProviderConfig,
        signal: AbortSignal,
        maxResponseBytes: number
    ): Promise<ProviderFetchPayload> {
        const apiKey = config.apiKey.trim();
        const root = rootOf(config.endpoint, 'https://api.tavily.com').replace(/\/search$/, '');
        const response = await tauriFetch(`${root}/extract`, {
            method: 'POST',
            headers: {
                ...(apiKey
                    ? { Authorization: `Bearer ${apiKey}` }
                    : { 'x-tavily-access-mode': 'keyless' }),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ urls: [url], extract_depth: 'advanced' }),
            signal,
        });
        await requireOk(response, 'Tavily');
        const payload = await readJson(response, maxResponseBytes);
        const first = recordOf(Array.isArray(payload.results) ? payload.results[0] : undefined);
        return {
            provider: 'tavily',
            title: normalizeOptionalString(first.title),
            finalUrl: normalizeOptionalString(first.url),
            content: normalizeOptionalString(first.raw_content) ?? '',
        };
    }

    async function fetchFirecrawl(
        url: string,
        config: SearchProviderConfig,
        signal: AbortSignal,
        maxResponseBytes: number
    ): Promise<ProviderFetchPayload> {
        const apiKey = config.apiKey.trim();
        const root = rootOf(config.endpoint, 'https://api.firecrawl.dev').replace(
            /\/v2\/(?:search|scrape)$/i,
            ''
        );
        const response = await tauriFetch(`${root}/v2/scrape`, {
            method: 'POST',
            headers: {
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
            signal,
        });
        await requireOk(response, 'Firecrawl');
        const payload = await readJson(response, maxResponseBytes);
        const data = recordOf(payload.data);
        const metadata = recordOf(data.metadata);
        return {
            provider: 'firecrawl',
            title: normalizeOptionalString(metadata.title),
            finalUrl: normalizeOptionalString(metadata.sourceURL),
            publishedAt: normalizeOptionalString(metadata.publishedTime),
            content: normalizeOptionalString(data.markdown) ?? '',
        };
    }

    async function fetchKeenable(
        url: string,
        config: SearchProviderConfig,
        signal: AbortSignal,
        maxResponseBytes: number
    ): Promise<ProviderFetchPayload> {
        const apiKey = config.apiKey.trim();
        const root = rootOf(config.endpoint, 'https://api.keenable.ai');
        const target = new URL(`${root}${apiKey ? '/v1/fetch' : '/v1/fetch/public'}`);
        target.searchParams.set('url', url);
        const response = await tauriFetch(target.toString(), {
            method: 'GET',
            headers: apiKey ? { 'X-API-Key': apiKey } : { 'X-Keenable-Title': 'TouchAI' },
            signal,
        });
        await requireOk(response, 'Keenable');
        const payload = await readJson(response, maxResponseBytes);
        return {
            provider: 'keenable',
            title: normalizeOptionalString(payload.title),
            publishedAt: normalizeOptionalString(payload.published_at),
            content:
                normalizeOptionalString(payload.content) ??
                normalizeOptionalString(payload.markdown) ??
                '',
        };
    }

    async function fetchDoubao(
        url: string,
        config: SearchProviderConfig,
        signal: AbortSignal,
        maxResponseBytes: number
    ): Promise<ProviderFetchPayload> {
        const root = rootOf(config.endpoint, 'https://open.feedcoopapi.com').replace(
            /\/search_api(?:\/.*)?$/,
            ''
        );
        const response = await tauriFetch(`${root}/search_api/fetch`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.apiKey.trim()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ Url: url }),
            signal,
        });
        await requireOk(response, 'Doubao');
        const payload = await readJson(response, maxResponseBytes);
        const data = recordOf(recordOf(payload.Result).Data);
        return {
            provider: 'doubao',
            title: normalizeOptionalString(data.Title),
            finalUrl: normalizeOptionalString(data.Url),
            publishedAt: normalizeOptionalString(data.PublishTime),
            content: normalizeOptionalString(data.ContentText) ?? '',
        };
    }

    async function fetchTinyFish(
        url: string,
        config: SearchProviderConfig,
        signal: AbortSignal,
        maxResponseBytes: number
    ): Promise<ProviderFetchPayload> {
        const response = await tauriFetch(tinyfishEndpoint(config.endpoint, 'fetch').toString(), {
            method: 'POST',
            headers: { 'X-API-Key': config.apiKey.trim(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: [url], format: 'markdown' }),
            signal,
        });
        await requireOk(response, 'TinyFish');
        const payload = await readJson(response, maxResponseBytes);
        const first = recordOf(Array.isArray(payload.results) ? payload.results[0] : undefined);
        return {
            provider: 'tinyfish',
            title: normalizeOptionalString(first.title),
            finalUrl: normalizeOptionalString(first.final_url),
            publishedAt: normalizeOptionalString(first.published_date),
            content: normalizeOptionalString(first.text) ?? '',
        };
    }

    async function fetchSerper(
        url: string,
        config: SearchProviderConfig,
        signal: AbortSignal,
        maxResponseBytes: number
    ): Promise<ProviderFetchPayload> {
        const root = serperScrapeEndpoint(config.endpoint);
        const response = await tauriFetch(root, {
            method: 'POST',
            headers: { 'X-API-KEY': config.apiKey.trim(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, includeMarkdown: true }),
            signal,
        });
        await requireOk(response, 'Serper');
        const payload = await readJson(response, maxResponseBytes);
        const metadata = recordOf(payload.metadata);
        return {
            provider: 'serper',
            title: normalizeOptionalString(metadata.title),
            finalUrl: normalizeOptionalString(metadata.sourceURL),
            publishedAt: normalizeOptionalString(metadata.date),
            content:
                normalizeOptionalString(payload.markdown) ??
                normalizeOptionalString(payload.text) ??
                '',
        };
    }

    const FETCHERS: Record<
        FetchCapableProvider,
        (
            url: string,
            config: SearchProviderConfig,
            signal: AbortSignal,
            maxResponseBytes: number
        ) => Promise<ProviderFetchPayload>
    > = {
        anysearch: fetchAnySearch,
        deepseek: fetchDeepSeek,
        exa: fetchExa,
        tavily: fetchTavily,
        firecrawl: fetchFirecrawl,
        keenable: fetchKeenable,
        doubao: fetchDoubao,
        tinyfish: fetchTinyFish,
        serper: fetchSerper,
    };

    /**
     * 用已配置的搜索引擎直接抓正文。顺序沿用用户设置里的 providerPriority，
     * 只尝试启用且凭据齐全的引擎；单项失败继续下一个。
     */
    async function tryProviderFetches(
        url: string,
        settings: SearchSettingsConfig,
        signal: AbortSignal,
        maxResponseBytes: number,
        requested?: FetchCapableProvider
    ): Promise<ProviderFetchPayload | null> {
        const candidates = requested
            ? [requested]
            : settings.providerPriority.filter((provider): provider is FetchCapableProvider =>
                  FETCH_CAPABLE_PROVIDERS.includes(provider as FetchCapableProvider)
              );
        for (const provider of candidates) {
            signal.throwIfAborted();
            const config = settings.providers[provider];
            if (!config.enabled || config.fetchEnabled === false) continue;
            if (
                provider !== 'tavily' &&
                provider !== 'keenable' &&
                provider !== 'anysearch' &&
                !config.apiKey.trim()
            )
                continue;
            try {
                const payload = await FETCHERS[provider](url, config, signal, maxResponseBytes);
                signal.throwIfAborted();
                if (payload.content.trim()) {
                    return payload;
                }
            } catch {
                signal.throwIfAborted();
                // A provider failure may fall through to the next configured engine.
            }
        }
        return null;
    }
    return { tryProviderFetches };
}
