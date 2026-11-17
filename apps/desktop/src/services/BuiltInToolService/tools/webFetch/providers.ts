// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type {
    SearchProviderConfig,
    SearchProviderId,
    SearchSettingsConfig,
} from '@services/SettingsService/domain';

import { createTauriFetch } from '@/services/HttpService';
import { normalizeOptionalString } from '@/utils/text';

const tauriFetch = createTauriFetch();

/** 这些引擎的官方 API 都能直接返回一份可读正文，而不只是搜索结果摘要。 */
export const FETCH_CAPABLE_PROVIDERS = [
    'anysearch',
    'deepseek',
    'exa',
    'tavily',
    'firecrawl',
    'keenable',
    'doubao',
    'tinyfish',
    'serper',
] as const satisfies readonly SearchProviderId[];

export type FetchCapableProvider = (typeof FETCH_CAPABLE_PROVIDERS)[number];

export interface ProviderFetchPayload {
    provider: FetchCapableProvider;
    title?: string;
    content: string;
    finalUrl?: string;
    publishedAt?: string;
}

function rootOf(endpoint: string, fallback: string): string {
    const trimmed = endpoint.trim().replace(/\/+$/, '');
    return trimmed || fallback;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
    const payload = (await response.json()) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
}

function requireOk(response: Response, provider: string): void {
    if (!response.ok) {
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
    signal: AbortSignal
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
    requireOk(response, 'AnySearch');
    const payload = await readJson(response);
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
    signal: AbortSignal
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
    requireOk(response, 'DeepSeek');
    const payload = await readJson(response);
    return {
        provider: 'deepseek',
        title: normalizeOptionalString(payload.title),
        content: normalizeOptionalString(payload.content) ?? '',
    };
}

async function fetchExa(
    url: string,
    config: SearchProviderConfig,
    signal: AbortSignal
): Promise<ProviderFetchPayload> {
    if (!config.apiKey.trim()) {
        throw new Error(
            'Exa Fetch needs an API key. The keyless MCP endpoint only supports search.'
        );
    }
    const root = rootOf(config.endpoint, 'https://api.exa.ai');
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
    requireOk(response, 'Exa');
    const payload = await readJson(response);
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
    signal: AbortSignal
): Promise<ProviderFetchPayload> {
    const apiKey = config.apiKey.trim();
    const response = await tauriFetch('https://api.tavily.com/extract', {
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
    requireOk(response, 'Tavily');
    const payload = await readJson(response);
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
    signal: AbortSignal
): Promise<ProviderFetchPayload> {
    const apiKey = config.apiKey.trim();
    const root = rootOf(config.endpoint, 'https://api.firecrawl.dev');
    const response = await tauriFetch(`${root}/v2/scrape`, {
        method: 'POST',
        headers: {
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
        signal,
    });
    requireOk(response, 'Firecrawl');
    const payload = await readJson(response);
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
    signal: AbortSignal
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
    requireOk(response, 'Keenable');
    const payload = await readJson(response);
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
    signal: AbortSignal
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
    requireOk(response, 'Doubao');
    const payload = await readJson(response);
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
    signal: AbortSignal
): Promise<ProviderFetchPayload> {
    const root = rootOf(config.endpoint, 'https://api.search.tinyfish.ai').replace(
        /\/v1(?:\/search)?$/,
        ''
    );
    const response = await tauriFetch(`${root}/v1/fetch`, {
        method: 'POST',
        headers: { 'X-API-Key': config.apiKey.trim(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: [url], format: 'markdown' }),
        signal,
    });
    requireOk(response, 'TinyFish');
    const payload = await readJson(response);
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
    signal: AbortSignal
): Promise<ProviderFetchPayload> {
    const root = rootOf(config.endpoint, 'https://scrape.serper.dev');
    const response = await tauriFetch(root, {
        method: 'POST',
        headers: { 'X-API-KEY': config.apiKey.trim(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, includeMarkdown: true }),
        signal,
    });
    requireOk(response, 'Serper');
    const payload = await readJson(response);
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
        signal: AbortSignal
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
export async function tryProviderFetches(
    url: string,
    settings: SearchSettingsConfig,
    signal: AbortSignal
): Promise<ProviderFetchPayload | null> {
    const candidates = settings.providerPriority.filter(
        (provider): provider is FetchCapableProvider =>
            FETCH_CAPABLE_PROVIDERS.includes(provider as FetchCapableProvider)
    );
    for (const provider of candidates) {
        const config = settings.providers[provider];
        if (!config.enabled) continue;
        if (
            provider !== 'tavily' &&
            provider !== 'keenable' &&
            provider !== 'anysearch' &&
            !config.apiKey.trim()
        )
            continue;
        try {
            const payload = await FETCHERS[provider](url, config, signal);
            if (payload.content.trim()) {
                return payload;
            }
        } catch {
            // 一个引擎失败不阻塞其它引擎。
        }
    }
    return null;
}
