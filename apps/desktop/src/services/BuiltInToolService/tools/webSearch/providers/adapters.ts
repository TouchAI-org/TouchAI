import {
    SEARCH_PROVIDER_IDS,
    SEARCH_PROVIDER_METADATA,
    type SearchProviderId,
    type SearchSettingsConfig,
} from '@/stores/setting/sections/search';
import { normalizeOptionalString } from '@/utils/text';

import { decodeOpenAlexAbstract, type WebSearchResult } from '../helper';
import { readResultItems, recencyStartDate, resultFromGenericItem, resultLimit } from './common';
import type { WebSearchProviderAdapter } from './types';

function requiresApiKey(provider: SearchProviderId): boolean {
    return SEARCH_PROVIDER_METADATA[provider].apiKeyRequirement === 'required';
}

function requiresEndpoint(provider: SearchProviderId): boolean {
    return SEARCH_PROVIDER_METADATA[provider].endpointRequirement === 'required';
}

function defaultIsConfigured(provider: SearchProviderId, settings: SearchSettingsConfig): boolean {
    const config = settings.providers[provider];
    if (!config?.enabled && provider !== 'auto') {
        return false;
    }
    if (requiresApiKey(provider) && !config.apiKey.trim()) {
        return false;
    }
    if (requiresEndpoint(provider) && !config.endpoint.trim()) {
        return false;
    }
    return true;
}

function createAdapter(
    adapter: Omit<WebSearchProviderAdapter, 'isConfigured'> & {
        isConfigured?: WebSearchProviderAdapter['isConfigured'];
    }
): WebSearchProviderAdapter {
    return {
        ...adapter,
        isConfigured:
            adapter.isConfigured ??
            ((config) => {
                if (!config.enabled) {
                    return false;
                }
                if (requiresApiKey(adapter.id) && !config.apiKey.trim()) {
                    return false;
                }
                if (requiresEndpoint(adapter.id) && !config.endpoint.trim()) {
                    return false;
                }
                return true;
            }),
    };
}

const anySearchAdapter = createAdapter({
    id: 'anysearch',
    async search({ request, settings, signal, fetchJson }) {
        const url = new URL('https://api.anysearch.com/v1/search');
        const apiKey = settings.providers.anysearch.apiKey.trim();
        const payload = await fetchJson(url, signal, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
                query: request.query,
                max_results: resultLimit(request),
                ...(request.domains.length > 0 ? { domains: request.domains } : {}),
                ...(request.intent === 'news' ? { content_types: ['news', 'web'] } : {}),
                ...(request.recencyDays
                    ? {
                          constraint: {
                              freshness:
                                  request.recencyDays <= 1
                                      ? 'day'
                                      : request.recencyDays <= 7
                                        ? 'week'
                                        : request.recencyDays <= 31
                                          ? 'month'
                                          : 'year',
                          },
                      }
                    : {}),
            }),
        });

        return readResultItems(payload)
            .map((item) => resultFromGenericItem(item, 'AnySearch'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});

const wikipediaAdapter = createAdapter({
    id: 'wikipedia',
    async search({ request, signal, fetchJson }) {
        const url = new URL('https://en.wikipedia.org/w/api.php');
        url.searchParams.set('action', 'opensearch');
        url.searchParams.set('search', request.query);
        url.searchParams.set('limit', String(resultLimit(request)));
        url.searchParams.set('namespace', '0');
        url.searchParams.set('format', 'json');
        url.searchParams.set('origin', '*');

        const payload = await fetchJson(url, signal);
        if (!Array.isArray(payload)) {
            return [];
        }

        const titles = Array.isArray(payload[1]) ? payload[1] : [];
        const snippets = Array.isArray(payload[2]) ? payload[2] : [];
        const urls = Array.isArray(payload[3]) ? payload[3] : [];
        return titles
            .map((title, index): WebSearchResult | null => {
                const resultUrl = urls[index];
                if (typeof title !== 'string' || typeof resultUrl !== 'string') {
                    return null;
                }
                return {
                    title,
                    url: resultUrl,
                    snippet: typeof snippets[index] === 'string' ? snippets[index] : undefined,
                    source: 'Wikipedia',
                };
            })
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});

const openAlexAdapter = createAdapter({
    id: 'openalex',
    async search({ request, signal, fetchJson }) {
        const url = new URL('https://api.openalex.org/works');
        url.searchParams.set('search', request.query);
        url.searchParams.set('per-page', String(resultLimit(request)));

        const payload = await fetchJson(url, signal);
        const results =
            payload && typeof payload === 'object'
                ? (payload as { results?: unknown }).results
                : null;
        if (!Array.isArray(results)) {
            return [];
        }

        return results
            .map((item): WebSearchResult | null => {
                if (!item || typeof item !== 'object') {
                    return null;
                }
                const record = item as Record<string, unknown>;
                const primaryLocation =
                    record.primary_location && typeof record.primary_location === 'object'
                        ? (record.primary_location as Record<string, unknown>)
                        : {};
                const title = normalizeOptionalString(record.display_name);
                const url =
                    normalizeOptionalString(primaryLocation.landing_page_url) ??
                    normalizeOptionalString(record.id);
                if (!title || !url) {
                    return null;
                }

                const year =
                    typeof record.publication_year === 'number'
                        ? `Publication year: ${record.publication_year}. `
                        : '';
                return {
                    title,
                    url,
                    snippet:
                        `${year}${decodeOpenAlexAbstract(record.abstract_inverted_index) ?? ''}`.trim(),
                    source: 'OpenAlex',
                };
            })
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});

const semanticScholarAdapter = createAdapter({
    id: 'semantic_scholar',
    async search({ request, settings, signal, fetchJson }) {
        const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search');
        url.searchParams.set('query', request.query);
        url.searchParams.set('limit', String(resultLimit(request)));
        url.searchParams.set('fields', 'title,url,abstract,year,authors');
        const apiKey = settings.providers.semantic_scholar.apiKey.trim();

        const payload = await fetchJson(url, signal, {
            headers: apiKey ? { 'x-api-key': apiKey } : {},
        });
        return readResultItems(payload)
            .map((item): WebSearchResult | null => {
                if (!item || typeof item !== 'object') {
                    return null;
                }
                const record = item as Record<string, unknown>;
                const title = normalizeOptionalString(record.title);
                const paperId = normalizeOptionalString(record.paperId);
                const urlValue =
                    normalizeOptionalString(record.url) ??
                    (paperId ? `https://www.semanticscholar.org/paper/${paperId}` : undefined);
                if (!title || !urlValue) {
                    return null;
                }
                const year = typeof record.year === 'number' ? `${record.year}. ` : '';
                return {
                    title,
                    url: urlValue,
                    snippet: `${year}${normalizeOptionalString(record.abstract) ?? ''}`.trim(),
                    source: 'Semantic Scholar',
                };
            })
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});

const githubAdapter = createAdapter({
    id: 'github',
    async search({ request, signal, fetchJson }) {
        const url = new URL('https://api.github.com/search/repositories');
        url.searchParams.set('q', request.query);
        url.searchParams.set('per_page', String(resultLimit(request)));

        const payload = await fetchJson(url, signal);
        const items =
            payload && typeof payload === 'object' ? (payload as { items?: unknown }).items : null;
        if (!Array.isArray(items)) {
            return [];
        }

        return items
            .map((item): WebSearchResult | null => {
                if (!item || typeof item !== 'object') {
                    return null;
                }
                const record = item as Record<string, unknown>;
                const title = normalizeOptionalString(record.full_name);
                const url = normalizeOptionalString(record.html_url);
                if (!title || !url) {
                    return null;
                }

                const description = normalizeOptionalString(record.description) ?? '';
                const stars =
                    typeof record.stargazers_count === 'number'
                        ? `Stars: ${record.stargazers_count}. `
                        : '';
                return {
                    title,
                    url,
                    snippet: `${stars}${description}`.trim(),
                    source: 'GitHub',
                };
            })
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});

function searxngSearchUrl(endpoint: string): URL {
    const base = new URL(endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
    return new URL('search', base);
}

const searxngAdapter = createAdapter({
    id: 'searxng',
    async search({ request, settings, signal, fetchJson }) {
        const endpoint = settings.providers.searxng.endpoint.trim();
        if (!endpoint) {
            return [];
        }
        const url = searxngSearchUrl(endpoint);
        url.searchParams.set('q', request.query);
        url.searchParams.set('format', 'json');
        url.searchParams.set('language', 'auto');
        url.searchParams.set('safesearch', '0');

        const payload = await fetchJson(url, signal);
        return readResultItems(payload)
            .slice(0, resultLimit(request))
            .map((item) => resultFromGenericItem(item, 'SearXNG'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});

function braveFreshness(recencyDays: number | undefined): string | undefined {
    if (!recencyDays) {
        return undefined;
    }
    if (recencyDays <= 1) {
        return 'pd';
    }
    if (recencyDays <= 7) {
        return 'pw';
    }
    if (recencyDays <= 31) {
        return 'pm';
    }
    return 'py';
}

const braveAdapter = createAdapter({
    id: 'brave',
    async search({ request, settings, signal, fetchJson }) {
        const url = new URL('https://api.search.brave.com/res/v1/web/search');
        url.searchParams.set('q', request.query);
        url.searchParams.set('count', String(resultLimit(request)));
        const freshness = braveFreshness(request.recencyDays);
        if (freshness) {
            url.searchParams.set('freshness', freshness);
        }

        const payload = await fetchJson(url, signal, {
            headers: {
                'X-Subscription-Token': settings.providers.brave.apiKey.trim(),
            },
        });
        const webResults =
            payload && typeof payload === 'object'
                ? (payload as { web?: { results?: unknown } }).web?.results
                : null;
        if (!Array.isArray(webResults)) {
            return [];
        }
        return webResults
            .map((item) => resultFromGenericItem(item, 'Brave'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});

const tavilyAdapter = createAdapter({
    id: 'tavily',
    async search({ request, settings, signal, fetchJson }) {
        const body: Record<string, unknown> = {
            query: request.query,
            topic: request.intent === 'news' ? 'news' : 'general',
            search_depth: 'basic',
            max_results: resultLimit(request),
            include_answer: false,
            include_raw_content: false,
        };
        if (request.domains.length > 0) {
            body.include_domains = request.domains;
        }

        const payload = await fetchJson(new URL('https://api.tavily.com/search'), signal, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${settings.providers.tavily.apiKey.trim()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        return readResultItems(payload)
            .map((item) => resultFromGenericItem(item, 'Tavily'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});

const exaAdapter = createAdapter({
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

function readFirecrawlResults(payload: unknown): unknown[] {
    if (!payload || typeof payload !== 'object') {
        return [];
    }
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) {
        return data;
    }
    if (data && typeof data === 'object') {
        const record = data as Record<string, unknown>;
        return ['web', 'news', 'images'].flatMap((key) =>
            Array.isArray(record[key]) ? record[key] : []
        );
    }
    return [];
}

const firecrawlAdapter = createAdapter({
    id: 'firecrawl',
    async search({ request, settings, signal, fetchJson }) {
        const body: Record<string, unknown> = {
            query: request.query,
            limit: resultLimit(request),
            sources: request.intent === 'news' ? ['web', 'news'] : ['web'],
        };
        if (request.recencyDays) {
            body.tbs = `qdr:${request.recencyDays <= 1 ? 'd' : request.recencyDays <= 7 ? 'w' : request.recencyDays <= 31 ? 'm' : 'y'}`;
        }

        const payload = await fetchJson(new URL('https://api.firecrawl.dev/v2/search'), signal, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${settings.providers.firecrawl.apiKey.trim()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        return readFirecrawlResults(payload)
            .map((item) => resultFromGenericItem(item, 'Firecrawl'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});

export const WEB_SEARCH_PROVIDER_ADAPTERS = [
    anySearchAdapter,
    wikipediaAdapter,
    openAlexAdapter,
    semanticScholarAdapter,
    githubAdapter,
    braveAdapter,
    tavilyAdapter,
    exaAdapter,
    firecrawlAdapter,
    searxngAdapter,
] as const satisfies readonly WebSearchProviderAdapter[];

export const WEB_SEARCH_PROVIDER_ADAPTER_BY_ID = Object.fromEntries(
    WEB_SEARCH_PROVIDER_ADAPTERS.map((adapter) => [adapter.id, adapter])
) as Partial<Record<SearchProviderId, WebSearchProviderAdapter>>;

export function getSearchProviderAdapter(
    provider: SearchProviderId
): WebSearchProviderAdapter | null {
    return WEB_SEARCH_PROVIDER_ADAPTER_BY_ID[provider] ?? null;
}

export function isConfiguredSearchProvider(
    provider: SearchProviderId,
    settings: SearchSettingsConfig
): boolean {
    const adapter = getSearchProviderAdapter(provider);
    if (!adapter) {
        return provider === 'auto' && defaultIsConfigured(provider, settings);
    }
    return adapter.isConfigured(settings.providers[provider]);
}

export function getAvailableSearchProviders(settings: SearchSettingsConfig): SearchProviderId[] {
    return SEARCH_PROVIDER_IDS.filter((provider) => isConfiguredSearchProvider(provider, settings));
}
