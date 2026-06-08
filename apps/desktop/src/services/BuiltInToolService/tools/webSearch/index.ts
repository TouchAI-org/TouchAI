import { getSettingValue } from '@database/queries';

import {
    parseSearchSettingsConfig,
    SEARCH_SETTINGS_KEY,
    type SearchProviderId,
    type SearchSettingsConfig,
} from '@/config/searchSettings';
import { createTauriFetch } from '@/services/AgentService/infrastructure/providers';
import { normalizeOptionalString, truncateText } from '@/utils/text';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import {
    buildWebSearchToolDescription,
    buildWebSearchToolInputSchema,
    WEB_SEARCH_PROVIDERS,
    WEB_SEARCH_TOOL_DESCRIPTION,
    WEB_SEARCH_TOOL_ID,
    WEB_SEARCH_TOOL_INPUT_SCHEMA,
    type WebSearchProvider,
} from './constants';
import {
    createSearchSignal,
    decodeOpenAlexAbstract,
    formatWebSearchResults,
    parseWebSearchRequest,
    type WebSearchRequest,
    type WebSearchResult,
} from './helper';

const tauriFetch = createTauriFetch();

function stripSearchActionPrefix(value: string): string {
    const original = value.trim();
    let current = original;

    for (let index = 0; index < 3; index += 1) {
        const next = current
            .replace(
                /^(?:搜索|查找|检索|查询|搜寻|寻找|调研|研究|了解|查看|收集|获取)(?:一下|有关|关于)?[\s:：,，。-]*/u,
                ''
            )
            .replace(
                /^(?:search(?:ing)?(?:\s+for)?|find|look\s+up|lookup|research|investigate|collect(?:\s+info(?:rmation)?)?(?:\s+about)?)\s*[:：-]?\s+/iu,
                ''
            )
            .trim();

        if (!next || next === current) {
            break;
        }
        current = next;
    }

    return current || original;
}

function buildSearchSemanticTarget(args: Record<string, unknown>): string {
    const description = normalizeOptionalString(args.description, { collapseWhitespace: true });
    const query = normalizeOptionalString(args.query, { collapseWhitespace: true });
    return truncateText(stripSearchActionPrefix(description ?? query ?? 'web'), 100);
}

function extractSearchResultSources(results: WebSearchResult[]): string[] {
    return results
        .map((result) => result.source.trim())
        .filter(Boolean)
        .filter((source, index, sources) => sources.indexOf(source) === index);
}

function formatSearchSourceSuffix(sources: string[]): string | null {
    if (sources.length === 0) {
        return null;
    }
    if (sources.length <= 2) {
        return sources.join('/');
    }
    return `${sources.slice(0, 2).join('/')} 等 ${sources.length} 个来源`;
}

const SEARCH_PROVIDER_DISPLAY_NAMES: Record<SearchProviderId, string> = {
    auto: '自动',
    anysearch: 'AnySearch',
    wikipedia: 'Wikipedia',
    openalex: 'OpenAlex',
    semantic_scholar: 'Semantic Scholar',
    github: 'GitHub',
    brave: 'Brave',
    tavily: 'Tavily',
    exa: 'Exa',
    firecrawl: 'Firecrawl',
    searxng: 'SearXNG',
};

function buildSearchSemantic(args: Record<string, unknown>): BuiltInToolConversationSemantic {
    return {
        action: 'search',
        target: buildSearchSemanticTarget(args),
    };
}

function buildSearchSemanticForResults(
    args: Record<string, unknown>,
    results: WebSearchResult[],
    provider: SearchProviderId
): BuiltInToolConversationSemantic {
    const resultSources = extractSearchResultSources(results);
    const sourceSuffix = formatSearchSourceSuffix(
        resultSources.length > 0 ? resultSources : [SEARCH_PROVIDER_DISPLAY_NAMES[provider]]
    );
    const target = buildSearchSemanticTarget(args);
    return {
        action: 'search',
        target: sourceSuffix ? truncateText(`${target} · ${sourceSuffix}`, 100) : target,
    };
}

async function fetchJson(
    url: URL,
    signal: AbortSignal,
    init: {
        method?: 'GET' | 'POST';
        headers?: Record<string, string>;
        body?: string;
    } = {}
): Promise<unknown> {
    const response = await tauriFetch(url.toString(), {
        method: init.method ?? 'GET',
        headers: {
            Accept: 'application/json',
            'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            ...(init.headers ?? {}),
        },
        body: init.body,
        signal,
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }

    return await response.json();
}

function resultLimit(request: WebSearchRequest): number {
    return Math.max(1, Math.min(10, request.maxResults));
}

async function loadSearchSettings(): Promise<SearchSettingsConfig> {
    return parseSearchSettingsConfig(await getSettingValue({ key: SEARCH_SETTINGS_KEY }));
}

async function searchWikipedia(
    request: WebSearchRequest,
    signal: AbortSignal
): Promise<WebSearchResult[]> {
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
}

function readResultItems(payload: unknown): unknown[] {
    if (Array.isArray(payload)) {
        return payload;
    }
    if (!payload || typeof payload !== 'object') {
        return [];
    }
    const record = payload as Record<string, unknown>;
    for (const key of ['results', 'data', 'items']) {
        const value = record[key];
        if (Array.isArray(value)) {
            return value;
        }
        if (value && typeof value === 'object') {
            const nested = value as Record<string, unknown>;
            for (const nestedKey of ['results', 'items']) {
                const nestedValue = nested[nestedKey];
                if (Array.isArray(nestedValue)) {
                    return nestedValue;
                }
            }
        }
    }
    return [];
}

function resultFromGenericItem(item: unknown, source: string): WebSearchResult | null {
    if (!item || typeof item !== 'object') {
        return null;
    }
    const record = item as Record<string, unknown>;
    const title =
        normalizeOptionalString(record.title) ??
        normalizeOptionalString(record.name) ??
        normalizeOptionalString(record.display_name);
    const url =
        normalizeOptionalString(record.url) ??
        normalizeOptionalString(record.link) ??
        normalizeOptionalString(record.href);
    if (!title || !url) {
        return null;
    }
    const snippet =
        normalizeOptionalString(record.snippet) ??
        normalizeOptionalString(record.description) ??
        normalizeOptionalString(record.content) ??
        normalizeOptionalString(record.text) ??
        normalizeOptionalString(record.abstract);
    return { title, url, snippet, source };
}

async function searchAnySearch(
    request: WebSearchRequest,
    settings: SearchSettingsConfig,
    signal: AbortSignal
): Promise<WebSearchResult[]> {
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
}

async function searchOpenAlex(
    request: WebSearchRequest,
    signal: AbortSignal
): Promise<WebSearchResult[]> {
    const url = new URL('https://api.openalex.org/works');
    url.searchParams.set('search', request.query);
    url.searchParams.set('per-page', String(resultLimit(request)));

    const payload = await fetchJson(url, signal);
    const results =
        payload && typeof payload === 'object' ? (payload as { results?: unknown }).results : null;
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
}

async function searchSemanticScholar(
    request: WebSearchRequest,
    settings: SearchSettingsConfig,
    signal: AbortSignal
): Promise<WebSearchResult[]> {
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
            const urlValue =
                normalizeOptionalString(record.url) ??
                (normalizeOptionalString(record.paperId)
                    ? `https://www.semanticscholar.org/paper/${normalizeOptionalString(record.paperId)}`
                    : undefined);
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
}

async function searchGitHubRepositories(
    request: WebSearchRequest,
    signal: AbortSignal
): Promise<WebSearchResult[]> {
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
}

function searxngSearchUrl(endpoint: string): URL {
    const base = new URL(endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
    return new URL('search', base);
}

async function searchSearxng(
    request: WebSearchRequest,
    settings: SearchSettingsConfig,
    signal: AbortSignal
): Promise<WebSearchResult[]> {
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
}

function recencyStartDate(recencyDays: number | undefined): string | undefined {
    if (!recencyDays) {
        return undefined;
    }
    const date = new Date(Date.now() - recencyDays * 24 * 60 * 60 * 1000);
    return date.toISOString();
}

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

async function searchBrave(
    request: WebSearchRequest,
    settings: SearchSettingsConfig,
    signal: AbortSignal
): Promise<WebSearchResult[]> {
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
}

async function searchTavily(
    request: WebSearchRequest,
    settings: SearchSettingsConfig,
    signal: AbortSignal
): Promise<WebSearchResult[]> {
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
}

async function searchExa(
    request: WebSearchRequest,
    settings: SearchSettingsConfig,
    signal: AbortSignal
): Promise<WebSearchResult[]> {
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
}

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

async function searchFirecrawl(
    request: WebSearchRequest,
    settings: SearchSettingsConfig,
    signal: AbortSignal
): Promise<WebSearchResult[]> {
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
}

function isProviderConfigured(
    provider: WebSearchProvider,
    settings: SearchSettingsConfig
): boolean {
    const config = settings.providers[provider];
    if (!config?.enabled && provider !== 'auto') {
        return false;
    }
    if (
        provider === 'brave' ||
        provider === 'tavily' ||
        provider === 'exa' ||
        provider === 'firecrawl'
    ) {
        return Boolean(config.apiKey.trim());
    }
    if (provider === 'searxng') {
        return Boolean(config.endpoint.trim());
    }
    return true;
}

function availableSearchProviders(settings: SearchSettingsConfig): WebSearchProvider[] {
    return WEB_SEARCH_PROVIDERS.filter((provider) => isProviderConfigured(provider, settings));
}

function routeProviderForSettings(
    request: WebSearchRequest,
    settings: SearchSettingsConfig
): SearchProviderId {
    if (request.intent && settings.intentRoutes[request.intent]) {
        const routedProvider = settings.intentRoutes[request.intent];
        if (routedProvider !== 'auto') {
            return routedProvider;
        }
    }

    return settings.defaultProvider;
}

function isExecutableSearchProvider(provider: SearchProviderId): boolean {
    return (
        provider === 'anysearch' ||
        provider === 'brave' ||
        provider === 'tavily' ||
        provider === 'exa' ||
        provider === 'firecrawl' ||
        provider === 'github' ||
        provider === 'semantic_scholar' ||
        provider === 'openalex' ||
        provider === 'searxng' ||
        provider === 'wikipedia'
    );
}

function resolveExecutableSearchProvider(
    request: WebSearchRequest,
    settings: SearchSettingsConfig
): SearchProviderId {
    const provider =
        request.provider !== 'auto'
            ? request.provider
            : routeProviderForSettings(request, settings);
    if (isExecutableSearchProvider(provider) && isProviderConfigured(provider, settings)) {
        return provider;
    }

    if (isProviderConfigured('anysearch', settings)) {
        return 'anysearch';
    }

    if (request.intent === 'academic') {
        return 'openalex';
    }

    if (request.intent === 'technical') {
        return 'github';
    }

    return 'wikipedia';
}

async function runSearchProviders(
    request: WebSearchRequest,
    settings: SearchSettingsConfig,
    signal: AbortSignal,
    provider: SearchProviderId
): Promise<WebSearchResult[]> {
    if (provider === 'anysearch') {
        return searchAnySearch(request, settings, signal);
    }
    if (provider === 'brave') {
        return searchBrave(request, settings, signal);
    }
    if (provider === 'tavily') {
        return searchTavily(request, settings, signal);
    }
    if (provider === 'exa') {
        return searchExa(request, settings, signal);
    }
    if (provider === 'firecrawl') {
        return searchFirecrawl(request, settings, signal);
    }
    if (provider === 'github') {
        return searchGitHubRepositories(request, signal);
    }
    if (provider === 'semantic_scholar') {
        return searchSemanticScholar(request, settings, signal);
    }
    if (provider === 'openalex') {
        return searchOpenAlex(request, signal);
    }
    if (provider === 'searxng') {
        return searchSearxng(request, settings, signal);
    }
    if (provider === 'wikipedia') {
        return searchWikipedia(request, signal);
    }

    return [];
}

function applySearchSettingsDefaults(
    args: Record<string, unknown>,
    request: WebSearchRequest,
    settings: SearchSettingsConfig
): WebSearchRequest {
    return {
        ...request,
        maxResults:
            typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
                ? request.maxResults
                : settings.maxResults,
        timeoutMs:
            typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
                ? request.timeoutMs
                : settings.timeoutMs,
    };
}

export async function executeWebSearchTool(
    args: Record<string, unknown>,
    config: Record<string, never>,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    void config;
    const searchSettings = await loadSearchSettings();
    const request = applySearchSettingsDefaults(args, parseWebSearchRequest(args), searchSettings);
    const provider = resolveExecutableSearchProvider(request, searchSettings);
    const { signal, cleanup } = createSearchSignal(context.signal, request.timeoutMs);

    try {
        const results = await runSearchProviders(request, searchSettings, signal, provider);
        const limitedResults = results.slice(0, request.maxResults);
        return {
            result: formatWebSearchResults(request, limitedResults),
            isError: false,
            status: 'success',
            conversationSemantic: buildSearchSemanticForResults(args, limitedResults, provider),
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            result: `Web search failed\nQuery: ${request.query}\nReason: ${errorMessage}`,
            isError: true,
            status:
                error instanceof DOMException && error.name === 'TimeoutError'
                    ? 'timeout'
                    : 'error',
            errorMessage,
            conversationSemantic: buildSearchSemanticForResults(args, [], provider),
        };
    } finally {
        cleanup();
    }
}

class WebSearchTool extends BuiltInTool<Record<string, never>> {
    readonly id = WEB_SEARCH_TOOL_ID;
    readonly displayName = 'WebSearch';
    readonly description = WEB_SEARCH_TOOL_DESCRIPTION;
    readonly inputSchema = WEB_SEARCH_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override async buildToolDefinition(namespacedName: string) {
        const settings = await loadSearchSettings();
        const providers = availableSearchProviders(settings);
        return {
            name: namespacedName,
            description: buildWebSearchToolDescription(providers),
            input_schema: buildWebSearchToolInputSchema(providers),
        };
    }

    override buildConversationSemantic(args: Record<string, unknown>) {
        return buildSearchSemantic(args);
    }

    override execute(
        args: Record<string, unknown>,
        config: Record<string, never>,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeWebSearchTool(args, config, context);
    }
}

export const webSearchTool = new WebSearchTool();
export const builtInTools: BuiltInToolGroup = [webSearchTool];
