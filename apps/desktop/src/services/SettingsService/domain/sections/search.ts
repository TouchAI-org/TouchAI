import { z } from '@/utils/zod';

export const SEARCH_SETTINGS_KEY = 'search_settings';
export const SEARCH_SETTINGS_VERSION = 1;

export const SEARCH_PROVIDER_IDS = [
    'auto',
    'anysearch',
    'wikipedia',
    'openalex',
    'semantic_scholar',
    'github',
    'brave',
    'tavily',
    'exa',
    'firecrawl',
    'searxng',
    'deepseek',
    'keenable',
    'zhihu',
    'yuanbao',
    'grok',
    'doubao',
    'qianfan',
    'tinyfish',
    'serper',
] as const;

export const SEARCH_SOURCES = [
    'general',
    'news',
    'community',
    'academic',
    'code',
    'official',
    'realtime',
] as const;

export const WEB_FETCH_STRATEGIES = ['direct', 'fallback', 'prefer'] as const;

export const SEARCH_ROUTING_STRATEGIES = ['capability', 'manual', 'priority'] as const;

const LEGACY_ROUTING_STRATEGIES = ['model', 'intent', 'parallel'] as const;
export const SEARCH_PARALLEL_MAX = 5;

export const SEARCH_ROUTE_INTENTS = [
    'general',
    'academic',
    'technical',
    'official',
    'news',
] as const;

export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];
export type SearchRouteIntent = (typeof SEARCH_ROUTE_INTENTS)[number];
export type SearchSource = (typeof SEARCH_SOURCES)[number];
export type SearchRoutingStrategy = (typeof SEARCH_ROUTING_STRATEGIES)[number];
export type WebFetchStrategy = (typeof WEB_FETCH_STRATEGIES)[number];
export type SearchProviderApiKeyRequirement = 'none' | 'optional' | 'required';
export type SearchProviderEndpointRequirement = 'none' | 'required';

export interface SearchProviderMetadata {
    id: SearchProviderId;
    enabledByDefault: boolean;
    apiKeyRequirement: SearchProviderApiKeyRequirement;
    endpointRequirement: SearchProviderEndpointRequirement;
    displayName: string;
    sourceName: string;
    recommendation: string;
}

export const SEARCH_PROVIDER_METADATA: Record<SearchProviderId, SearchProviderMetadata> = {
    auto: {
        id: 'auto',
        enabledByDefault: true,
        apiKeyRequirement: 'none',
        endpointRequirement: 'none',
        displayName: 'Auto',
        sourceName: 'Auto',
        recommendation: 'Follow the user selection strategy, source routes and configured default.',
    },
    anysearch: {
        id: 'anysearch',
        enabledByDefault: true,
        apiKeyRequirement: 'optional',
        endpointRequirement: 'none',
        displayName: 'AnySearch',
        sourceName: 'AnySearch',
        recommendation:
            'Broad discovery across aggregated indexes; native tag/params select vertical sources.',
    },
    wikipedia: {
        id: 'wikipedia',
        enabledByDefault: true,
        apiKeyRequirement: 'none',
        endpointRequirement: 'none',
        displayName: 'Wikipedia',
        sourceName: 'Wikipedia',
        recommendation: 'Encyclopedic background only; avoid as the only source for recent topics.',
    },
    openalex: {
        id: 'openalex',
        enabledByDefault: true,
        apiKeyRequirement: 'optional',
        endpointRequirement: 'none',
        displayName: 'OpenAlex',
        sourceName: 'OpenAlex',
        recommendation:
            'Scholarly works, abstracts, citation and open-access metadata; native filter/sort/page options.',
    },
    semantic_scholar: {
        id: 'semantic_scholar',
        enabledByDefault: true,
        apiKeyRequirement: 'optional',
        endpointRequirement: 'none',
        displayName: 'Semantic Scholar',
        sourceName: 'Semantic Scholar',
        recommendation: 'Academic paper search and abstracts, especially AI/CS papers.',
    },
    github: {
        id: 'github',
        enabledByDefault: true,
        apiKeyRequirement: 'optional',
        endpointRequirement: 'none',
        displayName: 'GitHub',
        sourceName: 'GitHub',
        recommendation:
            'Repositories, issues/PRs, code, commits and users via searchType; code search requires a GitHub token.',
    },
    brave: {
        id: 'brave',
        enabledByDefault: false,
        apiKeyRequirement: 'required',
        endpointRequirement: 'none',
        displayName: 'Brave',
        sourceName: 'Brave',
        recommendation: 'Fresh broad web/news discovery when a Brave Search API key is configured.',
    },
    tavily: {
        id: 'tavily',
        enabledByDefault: true,
        apiKeyRequirement: 'optional',
        endpointRequirement: 'none',
        displayName: 'Tavily',
        sourceName: 'Tavily',
        recommendation:
            'Research-style broad web search with concise snippets; free without an API key.',
    },
    exa: {
        id: 'exa',
        enabledByDefault: true,
        apiKeyRequirement: 'optional',
        endpointRequirement: 'none',
        displayName: 'Exa',
        sourceName: 'Exa',
        recommendation:
            'Semantic web discovery for companies, products, articles, and high-signal pages; free via the public MCP endpoint without an API key.',
    },
    firecrawl: {
        id: 'firecrawl',
        enabledByDefault: true,
        apiKeyRequirement: 'optional',
        endpointRequirement: 'none',
        displayName: 'Firecrawl',
        sourceName: 'Firecrawl',
        recommendation: 'Search plus crawl-oriented discovery; free without an API key.',
    },
    searxng: {
        id: 'searxng',
        enabledByDefault: false,
        apiKeyRequirement: 'none',
        endpointRequirement: 'required',
        displayName: 'SearXNG',
        sourceName: 'SearXNG',
        recommendation: 'Configured metasearch instance when the user provides one.',
    },
    deepseek: {
        id: 'deepseek',
        enabledByDefault: false,
        apiKeyRequirement: 'required',
        endpointRequirement: 'none',
        displayName: 'DeepSeek',
        sourceName: 'DeepSeek',
        recommendation:
            'DeepSeek in-house engine with stronger Chinese and long-tail recall; requires a DeepSeek API key.',
    },
    keenable: {
        id: 'keenable',
        enabledByDefault: false,
        apiKeyRequirement: 'optional',
        endpointRequirement: 'none',
        displayName: 'Keenable',
        sourceName: 'Keenable',
        recommendation:
            'Independent web index with clean extracted snippets and publish-date filters; keyless calls are rate limited.',
    },
    zhihu: {
        id: 'zhihu',
        enabledByDefault: false,
        apiKeyRequirement: 'required',
        endpointRequirement: 'none',
        displayName: 'Zhihu',
        sourceName: 'Zhihu',
        recommendation:
            'Chinese Q&A and first-hand experience from Zhihu, with authority levels and vote counts; requires an Access Secret.',
    },
    yuanbao: {
        id: 'yuanbao',
        enabledByDefault: false,
        apiKeyRequirement: 'required',
        endpointRequirement: 'none',
        displayName: 'Yuanbao',
        sourceName: 'Yuanbao',
        recommendation:
            'Tencent ecosystem and Chinese time-sensitive web content across news, government and academic verticals; requires a service key.',
    },
    grok: {
        id: 'grok',
        enabledByDefault: false,
        apiKeyRequirement: 'required',
        endpointRequirement: 'none',
        displayName: 'Grok',
        sourceName: 'Grok',
        recommendation:
            'Real-time web and X discussion through the Grok web_search tool; requires an xAI API key.',
    },
    doubao: {
        id: 'doubao',
        enabledByDefault: false,
        apiKeyRequirement: 'required',
        endpointRequirement: 'none',
        displayName: 'Doubao Search',
        sourceName: 'Doubao',
        recommendation:
            'Chinese web, images and inline content via Doubao Search Custom; native edition=global enables global/visual search. Requires a Search console API key, not an Ark model key.',
    },
    qianfan: {
        id: 'qianfan',
        enabledByDefault: false,
        apiKeyRequirement: 'required',
        endpointRequirement: 'none',
        displayName: 'Baidu Qianfan',
        sourceName: 'Qianfan',
        recommendation:
            'Baidu web, image, video and structured information with site/date filters. Native edition selects standard/turbo. Returned content is a search excerpt, not a full page.',
    },
    tinyfish: {
        id: 'tinyfish',
        enabledByDefault: false,
        apiKeyRequirement: 'required',
        endpointRequirement: 'none',
        displayName: 'TinyFish',
        sourceName: 'TinyFish',
        recommendation:
            'Dedicated Search API for web, news and research papers, with purpose, dates, localization and paging. Fetch and browser agents are separate APIs.',
    },
    serper: {
        id: 'serper',
        enabledByDefault: false,
        apiKeyRequirement: 'required',
        endpointRequirement: 'none',
        displayName: 'Serper',
        sourceName: 'Serper',
        recommendation:
            'Google search results with web/news/images/videos, localization and paging; native searchType selects the vertical. Requires a Serper API key.',
    },
};

export const SEARCH_PROVIDER_API_KEY_REQUIREMENTS = Object.fromEntries(
    SEARCH_PROVIDER_IDS.map((providerId) => [
        providerId,
        SEARCH_PROVIDER_METADATA[providerId].apiKeyRequirement,
    ])
) as Record<SearchProviderId, SearchProviderApiKeyRequirement>;

export const SEARCH_PROVIDER_ENDPOINT_REQUIREMENTS = Object.fromEntries(
    SEARCH_PROVIDER_IDS.map((providerId) => [
        providerId,
        SEARCH_PROVIDER_METADATA[providerId].endpointRequirement,
    ])
) as Record<SearchProviderId, SearchProviderEndpointRequirement>;

export interface SearchProviderConfig {
    enabled: boolean;
    apiKey: string;
    endpoint: string;
}

export interface SearchSettingsConfig {
    version: typeof SEARCH_SETTINGS_VERSION;
    routingStrategy: SearchRoutingStrategy;
    fetchStrategy: WebFetchStrategy;
    defaultProvider: SearchProviderId;
    maxResults: number;
    timeoutMs: number;
    parallelProviders: boolean;
    fallbackEnabled: boolean;
    preferOfficialSources: boolean;
    providers: Record<SearchProviderId, SearchProviderConfig>;
    providerPriority: SearchProviderId[];
    sourceRoutes: Record<SearchSource, SearchProviderId>;
    intentRoutes: Record<SearchRouteIntent, SearchProviderId>;
    parallelProviderCount: number;
}

const providerIdSchema = z.enum(SEARCH_PROVIDER_IDS);
const strategySchema = z.enum([...SEARCH_ROUTING_STRATEGIES, ...LEGACY_ROUTING_STRATEGIES]);
const fetchStrategySchema = z.enum(WEB_FETCH_STRATEGIES);
const providerConfigSchema = z.object({
    enabled: z.boolean().optional(),
    apiKey: z.string().optional(),
    endpoint: z.string().optional(),
});

const searchSettingsSchema = z
    .object({
        version: z.number().int().optional(),
        routingStrategy: strategySchema.optional(),
        fetchStrategy: fetchStrategySchema.optional(),
        defaultProvider: providerIdSchema.optional(),
        maxResults: z.number().int().min(0).optional(),
        timeoutMs: z.number().int().min(1000).max(300000).optional(),
        parallelProviders: z.boolean().optional(),
        fallbackEnabled: z.boolean().optional(),
        preferOfficialSources: z.boolean().optional(),
        providers: z.record(z.string(), providerConfigSchema).optional(),
        providerPriority: z.array(providerIdSchema).optional(),
        sourceRoutes: z.record(z.string(), providerIdSchema).optional(),
        intentRoutes: z.record(z.string(), providerIdSchema).optional(),
        parallelProviderCount: z
            .number()
            .int()
            .min(2)
            .max(SEARCH_PROVIDER_IDS.length - 1)
            .optional(),
    })
    .passthrough();

function migrateRoutingStrategy(raw: string | undefined): {
    strategy: SearchRoutingStrategy;
    parallelOverride: boolean | null;
} {
    if (raw === 'parallel') {
        return { strategy: 'priority', parallelOverride: true };
    }
    if (raw === 'model' || raw === 'intent') {
        return { strategy: 'capability', parallelOverride: null };
    }
    return {
        strategy: raw === 'manual' || raw === 'priority' ? raw : 'capability',
        parallelOverride: null,
    };
}

function createDefaultProviders(): Record<SearchProviderId, SearchProviderConfig> {
    return Object.fromEntries(
        SEARCH_PROVIDER_IDS.map((providerId) => [
            providerId,
            {
                enabled: SEARCH_PROVIDER_METADATA[providerId].enabledByDefault,
                apiKey: '',
                endpoint: '',
            },
        ])
    ) as Record<SearchProviderId, SearchProviderConfig>;
}

export const DEFAULT_SEARCH_SETTINGS: SearchSettingsConfig = {
    version: SEARCH_SETTINGS_VERSION,
    routingStrategy: 'capability',
    fetchStrategy: 'fallback',
    defaultProvider: 'anysearch',
    maxResults: 0,
    timeoutMs: 15000,
    parallelProviders: false,
    fallbackEnabled: true,
    preferOfficialSources: true,
    providers: createDefaultProviders(),
    providerPriority: [
        'anysearch',
        'keenable',
        'tavily',
        'exa',
        'brave',
        'firecrawl',
        'wikipedia',
        'openalex',
        'semantic_scholar',
        'github',
        'zhihu',
        'yuanbao',
        'deepseek',
        'grok',
        'searxng',
        'doubao',
        'qianfan',
        'tinyfish',
        'serper',
    ],
    sourceRoutes: {
        general: 'auto',
        news: 'auto',
        community: 'auto',
        academic: 'auto',
        code: 'auto',
        official: 'auto',
        realtime: 'auto',
    },
    intentRoutes: {
        general: 'auto',
        academic: 'openalex',
        technical: 'github',
        official: 'auto',
        news: 'auto',
    },
    parallelProviderCount: 3,
};

function cloneDefaultSearchSettings(): SearchSettingsConfig {
    return {
        ...DEFAULT_SEARCH_SETTINGS,
        providers: createDefaultProviders(),
        sourceRoutes: { ...DEFAULT_SEARCH_SETTINGS.sourceRoutes },
        intentRoutes: { ...DEFAULT_SEARCH_SETTINGS.intentRoutes },
        providerPriority: [...DEFAULT_SEARCH_SETTINGS.providerPriority],
    };
}

function normalizeProviders(
    providers: Partial<Record<SearchProviderId, Partial<SearchProviderConfig>>> | undefined
): Record<SearchProviderId, SearchProviderConfig> {
    const next = createDefaultProviders();
    if (!providers) {
        return next;
    }

    for (const providerId of SEARCH_PROVIDER_IDS) {
        const provider = providers[providerId];
        if (!provider) {
            continue;
        }
        next[providerId] = {
            enabled: provider.enabled ?? next[providerId].enabled,
            apiKey: provider.apiKey?.trim() ?? '',
            endpoint: provider.endpoint?.trim() ?? '',
        };
        if (
            (SEARCH_PROVIDER_API_KEY_REQUIREMENTS[providerId] === 'required' &&
                !next[providerId].apiKey) ||
            (SEARCH_PROVIDER_ENDPOINT_REQUIREMENTS[providerId] === 'required' &&
                !next[providerId].endpoint)
        ) {
            next[providerId].enabled = false;
        }
    }
    return next;
}

function normalizeProviderSelection(
    providerId: SearchProviderId | undefined,
    providers: Record<SearchProviderId, SearchProviderConfig>
): SearchProviderId {
    if (!providerId || providerId === 'auto') {
        return 'auto';
    }
    return providers[providerId]?.enabled ? providerId : 'auto';
}

function normalizeSourceRoutes(
    routes: Partial<Record<SearchSource, SearchProviderId>> | undefined,
    providers: Record<SearchProviderId, SearchProviderConfig>
): Record<SearchSource, SearchProviderId> {
    const merged = {
        ...DEFAULT_SEARCH_SETTINGS.sourceRoutes,
        ...(routes ?? {}),
    };
    return Object.fromEntries(
        SEARCH_SOURCES.map((source) => [
            source,
            normalizeProviderSelection(merged[source], providers),
        ])
    ) as Record<SearchSource, SearchProviderId>;
}

function normalizeProviderPriority(
    priority: readonly SearchProviderId[] | undefined
): SearchProviderId[] {
    const seen = new Set<SearchProviderId>();
    const result: SearchProviderId[] = [];
    for (const provider of priority ?? DEFAULT_SEARCH_SETTINGS.providerPriority) {
        if (provider === 'auto' || seen.has(provider)) continue;
        seen.add(provider);
        result.push(provider);
    }
    for (const provider of SEARCH_PROVIDER_IDS) {
        if (provider !== 'auto' && !seen.has(provider)) {
            result.push(provider);
        }
    }
    return result;
}

function normalizeIntentRoutes(
    routes: Partial<Record<SearchRouteIntent, SearchProviderId>> | undefined,
    providers: Record<SearchProviderId, SearchProviderConfig>
): Record<SearchRouteIntent, SearchProviderId> {
    const merged = {
        ...DEFAULT_SEARCH_SETTINGS.intentRoutes,
        ...(routes ?? {}),
    };
    return Object.fromEntries(
        SEARCH_ROUTE_INTENTS.map((intent) => [
            intent,
            normalizeProviderSelection(merged[intent], providers),
        ])
    ) as Record<SearchRouteIntent, SearchProviderId>;
}

export function parseSearchSettingsConfig(configJson: string | null): SearchSettingsConfig {
    if (!configJson) {
        return cloneDefaultSearchSettings();
    }

    try {
        const parsed = searchSettingsSchema.safeParse(JSON.parse(configJson));
        if (!parsed.success) {
            return cloneDefaultSearchSettings();
        }
        const data = parsed.data;
        const providers = normalizeProviders(data.providers);
        return {
            version: SEARCH_SETTINGS_VERSION,
            routingStrategy: migrateRoutingStrategy(data.routingStrategy).strategy,
            fetchStrategy: data.fetchStrategy ?? DEFAULT_SEARCH_SETTINGS.fetchStrategy,
            defaultProvider: normalizeProviderSelection(data.defaultProvider, providers),
            maxResults: data.maxResults ?? DEFAULT_SEARCH_SETTINGS.maxResults,
            timeoutMs: data.timeoutMs ?? DEFAULT_SEARCH_SETTINGS.timeoutMs,
            parallelProviders:
                migrateRoutingStrategy(data.routingStrategy).parallelOverride ??
                data.parallelProviders ??
                DEFAULT_SEARCH_SETTINGS.parallelProviders,
            fallbackEnabled: data.fallbackEnabled ?? DEFAULT_SEARCH_SETTINGS.fallbackEnabled,
            preferOfficialSources:
                data.preferOfficialSources ?? DEFAULT_SEARCH_SETTINGS.preferOfficialSources,
            providers,
            providerPriority: normalizeProviderPriority(data.providerPriority),
            sourceRoutes: normalizeSourceRoutes(data.sourceRoutes, providers),
            intentRoutes: normalizeIntentRoutes(data.intentRoutes, providers),
            parallelProviderCount: Math.min(
                SEARCH_PARALLEL_MAX,
                data.parallelProviderCount ?? DEFAULT_SEARCH_SETTINGS.parallelProviderCount
            ),
        };
    } catch {
        return cloneDefaultSearchSettings();
    }
}

export function serializeSearchSettingsConfig(config: SearchSettingsConfig): string {
    const providers = normalizeProviders(config.providers);
    const normalized: SearchSettingsConfig = {
        version: SEARCH_SETTINGS_VERSION,
        routingStrategy: migrateRoutingStrategy(config.routingStrategy).strategy,
        fetchStrategy: config.fetchStrategy,
        defaultProvider: normalizeProviderSelection(config.defaultProvider, providers),
        maxResults: Math.max(
            0,
            Math.trunc(
                Number.isFinite(config.maxResults)
                    ? config.maxResults
                    : DEFAULT_SEARCH_SETTINGS.maxResults
            )
        ),
        timeoutMs: Math.max(1000, Math.min(300000, Math.trunc(config.timeoutMs))),
        parallelProviders:
            migrateRoutingStrategy(config.routingStrategy).parallelOverride ??
            Boolean(config.parallelProviders),
        fallbackEnabled: Boolean(config.fallbackEnabled),
        preferOfficialSources: Boolean(config.preferOfficialSources),
        providers,
        providerPriority: normalizeProviderPriority(config.providerPriority),
        sourceRoutes: normalizeSourceRoutes(config.sourceRoutes, providers),
        intentRoutes: normalizeIntentRoutes(config.intentRoutes, providers),
        parallelProviderCount: Math.max(
            2,
            Math.min(SEARCH_PARALLEL_MAX, Math.trunc(config.parallelProviderCount))
        ),
    };
    return JSON.stringify(normalized);
}
