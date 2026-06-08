import { z } from '@/utils/zod';

export const SEARCH_SETTINGS_KEY = 'search_settings';

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

export const SEARCH_ROUTE_INTENTS = ['general', 'academic', 'technical', 'official', 'news'] as const;

export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];
export type SearchRouteIntent = (typeof SEARCH_ROUTE_INTENTS)[number];
export type SearchProviderApiKeyRequirement = 'none' | 'optional' | 'required';
export type SearchProviderEndpointRequirement = 'none' | 'required';

export const SEARCH_PROVIDER_API_KEY_REQUIREMENTS: Record<
    SearchProviderId,
    SearchProviderApiKeyRequirement
> = {
    auto: 'none',
    anysearch: 'optional',
    wikipedia: 'none',
    openalex: 'none',
    semantic_scholar: 'optional',
    github: 'none',
    brave: 'required',
    tavily: 'required',
    exa: 'required',
    firecrawl: 'required',
    searxng: 'none',
};

export const SEARCH_PROVIDER_ENDPOINT_REQUIREMENTS: Record<
    SearchProviderId,
    SearchProviderEndpointRequirement
> = {
    auto: 'none',
    anysearch: 'none',
    wikipedia: 'none',
    openalex: 'none',
    semantic_scholar: 'none',
    github: 'none',
    brave: 'none',
    tavily: 'none',
    exa: 'none',
    firecrawl: 'none',
    searxng: 'required',
};

export interface SearchProviderConfig {
    enabled: boolean;
    apiKey: string;
    endpoint: string;
}

export interface SearchSettingsConfig {
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
                enabled:
                    providerId === 'auto' ||
                    providerId === 'anysearch' ||
                    providerId === 'wikipedia' ||
                    providerId === 'openalex' ||
                    providerId === 'semantic_scholar' ||
                    providerId === 'github',
                apiKey: '',
                endpoint: '',
            },
        ])
    ) as Record<SearchProviderId, SearchProviderConfig>;
}

export const DEFAULT_SEARCH_SETTINGS: SearchSettingsConfig = {
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
