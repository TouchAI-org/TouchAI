import {
    SEARCH_PROVIDER_IDS,
    SEARCH_PROVIDER_METADATA,
    type SearchProviderId,
    type SearchSettingsConfig,
} from '@/stores/setting/sections/search';

import { anySearchAdapter } from './anysearch';
import { braveAdapter } from './brave';
import { exaAdapter } from './exa';
import { firecrawlAdapter } from './firecrawl';
import { githubAdapter } from './github';
import { openAlexAdapter } from './openalex';
import { searxngAdapter } from './searxng';
import { semanticScholarAdapter } from './semanticScholar';
import { tavilyAdapter } from './tavily';
import type { WebSearchProviderAdapter } from './types';
import { wikipediaAdapter } from './wikipedia';

function requiresApiKey(provider: SearchProviderId): boolean {
    return SEARCH_PROVIDER_METADATA[provider].apiKeyRequirement === 'required';
}

function requiresEndpoint(provider: SearchProviderId): boolean {
    return SEARCH_PROVIDER_METADATA[provider].endpointRequirement === 'required';
}

function isAutoProviderConfigured(
    provider: SearchProviderId,
    settings: SearchSettingsConfig
): boolean {
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
        return provider === 'auto' && isAutoProviderConfigured(provider, settings);
    }
    return adapter.isConfigured(settings.providers[provider]);
}

export function getAvailableSearchProviders(settings: SearchSettingsConfig): SearchProviderId[] {
    return SEARCH_PROVIDER_IDS.filter((provider) => isConfiguredSearchProvider(provider, settings));
}
