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
] as const;

export const SEARCH_ROUTE_INTENTS = [
    'general',
    'academic',
    'technical',
    'official',
    'news',
] as const;

export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];
export type SearchRouteIntent = (typeof SEARCH_ROUTE_INTENTS)[number];
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
        recommendation: 'Follow user settings; by default this resolves to anysearch.',
    },
    anysearch: {
        id: 'anysearch',
        enabledByDefault: true,
        apiKeyRequirement: 'optional',
        endpointRequirement: 'none',
        displayName: 'AnySearch',
        sourceName: 'AnySearch',
        recommendation: 'Recommended default for general research and broad web discovery.',
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
        apiKeyRequirement: 'none',
        endpointRequirement: 'none',
        displayName: 'OpenAlex',
        sourceName: 'OpenAlex',
        recommendation: 'Scholarly papers, authors, institutions, and academic metadata.',
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
        apiKeyRequirement: 'none',
        endpointRequirement: 'none',
        displayName: 'GitHub',
        sourceName: 'GitHub',
        recommendation: 'Repositories, releases, issues, code projects, and project activity.',
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
        enabledByDefault: false,
        apiKeyRequirement: 'required',
        endpointRequirement: 'none',
        displayName: 'Tavily',
        sourceName: 'Tavily',
        recommendation: 'Research-style broad web search with concise snippets when configured.',
    },
    exa: {
        id: 'exa',
        enabledByDefault: false,
        apiKeyRequirement: 'required',
        endpointRequirement: 'none',
        displayName: 'Exa',
        sourceName: 'Exa',
        recommendation:
            'Semantic web discovery for companies, products, articles, and high-signal pages.',
    },
    firecrawl: {
        id: 'firecrawl',
        enabledByDefault: false,
        apiKeyRequirement: 'required',
        endpointRequirement: 'none',
        displayName: 'Firecrawl',
        sourceName: 'Firecrawl',
        recommendation: 'Search plus crawl-oriented discovery when configured.',
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
    defaultProvider: SearchProviderId;
    maxResults: number;
    timeoutMs: number;
    parallelProviders: boolean;
    fallbackEnabled: boolean;
    preferOfficialSources: boolean;
    providers: Record<SearchProviderId, SearchProviderConfig>;
    intentRoutes: Record<SearchRouteIntent, SearchProviderId>;
}

const providerIdSchema = z.enum(SEARCH_PROVIDER_IDS);
const providerConfigSchema = z.object({
    enabled: z.boolean().optional(),
    apiKey: z.string().optional(),
    endpoint: z.string().optional(),
});

const searchSettingsSchema = z
    .object({
        version: z.number().int().optional(),
        defaultProvider: providerIdSchema.optional(),
        maxResults: z.number().int().min(1).max(10).optional(),
        timeoutMs: z.number().int().min(1000).max(60000).optional(),
        parallelProviders: z.boolean().optional(),
        fallbackEnabled: z.boolean().optional(),
        preferOfficialSources: z.boolean().optional(),
        providers: z.record(z.string(), providerConfigSchema).optional(),
        intentRoutes: z.record(z.string(), providerIdSchema).optional(),
    })
    .passthrough();

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
    defaultProvider: 'anysearch',
    maxResults: 6,
    timeoutMs: 15000,
    parallelProviders: false,
    fallbackEnabled: true,
    preferOfficialSources: true,
    providers: createDefaultProviders(),
    intentRoutes: {
        general: 'auto',
        academic: 'openalex',
        technical: 'github',
        official: 'auto',
        news: 'auto',
    },
};

function cloneDefaultSearchSettings(): SearchSettingsConfig {
    return {
        ...DEFAULT_SEARCH_SETTINGS,
        providers: createDefaultProviders(),
        intentRoutes: { ...DEFAULT_SEARCH_SETTINGS.intentRoutes },
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
            defaultProvider: normalizeProviderSelection(data.defaultProvider, providers),
            maxResults: data.maxResults ?? DEFAULT_SEARCH_SETTINGS.maxResults,
            timeoutMs: data.timeoutMs ?? DEFAULT_SEARCH_SETTINGS.timeoutMs,
            parallelProviders: data.parallelProviders ?? DEFAULT_SEARCH_SETTINGS.parallelProviders,
            fallbackEnabled: data.fallbackEnabled ?? DEFAULT_SEARCH_SETTINGS.fallbackEnabled,
            preferOfficialSources:
                data.preferOfficialSources ?? DEFAULT_SEARCH_SETTINGS.preferOfficialSources,
            providers,
            intentRoutes: normalizeIntentRoutes(data.intentRoutes, providers),
        };
    } catch {
        return cloneDefaultSearchSettings();
    }
}

export function serializeSearchSettingsConfig(config: SearchSettingsConfig): string {
    const providers = normalizeProviders(config.providers);
    const normalized: SearchSettingsConfig = {
        version: SEARCH_SETTINGS_VERSION,
        defaultProvider: normalizeProviderSelection(config.defaultProvider, providers),
        maxResults: Math.max(1, Math.min(10, Math.trunc(config.maxResults))),
        timeoutMs: Math.max(1000, Math.min(60000, Math.trunc(config.timeoutMs))),
        parallelProviders: Boolean(config.parallelProviders),
        fallbackEnabled: Boolean(config.fallbackEnabled),
        preferOfficialSources: Boolean(config.preferOfficialSources),
        providers,
        intentRoutes: normalizeIntentRoutes(config.intentRoutes, providers),
    };
    return JSON.stringify(normalized);
}
