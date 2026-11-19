import {
    SEARCH_PROVIDER_IDS,
    SEARCH_PROVIDER_METADATA,
    type SearchProviderId,
    type SearchSettingsConfig,
} from '../configuration';
import { anySearchAdapter } from './anysearch';
import { braveAdapter } from './brave';
import { createDeepSeekSearchAdapter } from './deepseek';
import { exaAdapter } from './exa';
import { firecrawlAdapter } from './firecrawl';
import { githubAdapter } from './github';
import { openAlexAdapter } from './openalex';
import { searxngAdapter } from './searxng';
import { semanticScholarAdapter } from './semanticScholar';
import { tavilyAdapter } from './tavily';
import type { WebSearchProviderAdapter } from './types';
import { wikipediaAdapter } from './wikipedia';

export function createSearchProviders() {
    function requiresApiKey(provider: SearchProviderId): boolean {
        return SEARCH_PROVIDER_METADATA[provider].apiKeyRequirement === 'required';
    }

    function requiresEndpoint(provider: SearchProviderId): boolean {
        return SEARCH_PROVIDER_METADATA[provider].endpointRequirement === 'required';
    }

    function isConcreteProviderConfigured(
        provider: SearchProviderId,
        settings: SearchSettingsConfig
    ): boolean {
        const config = settings.providers[provider];
        if (!config?.enabled) {
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

    function isAutoProviderConfigured(settings: SearchSettingsConfig): boolean {
        return SEARCH_PROVIDER_IDS.some(
            (provider) =>
                provider !== 'auto' &&
                getSearchProviderAdapter(provider) &&
                isConcreteProviderConfigured(provider, settings)
        );
    }

    const WEB_SEARCH_PROVIDER_ADAPTERS = [
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
        createDeepSeekSearchAdapter(),
    ] as const satisfies readonly WebSearchProviderAdapter[];

    const WEB_SEARCH_PROVIDER_ADAPTER_BY_ID = Object.fromEntries(
        WEB_SEARCH_PROVIDER_ADAPTERS.map((adapter) => [adapter.id, adapter])
    ) as Partial<Record<SearchProviderId, WebSearchProviderAdapter>>;

    function getSearchProviderAdapter(provider: SearchProviderId): WebSearchProviderAdapter | null {
        return WEB_SEARCH_PROVIDER_ADAPTER_BY_ID[provider] ?? null;
    }

    function isConfiguredSearchProvider(
        provider: SearchProviderId,
        settings: SearchSettingsConfig
    ): boolean {
        const adapter = getSearchProviderAdapter(provider);
        if (!adapter) {
            return provider === 'auto' && isAutoProviderConfigured(settings);
        }
        return (
            isConcreteProviderConfigured(provider, settings) &&
            adapter.isConfigured(settings.providers[provider])
        );
    }

    function getAvailableSearchProviders(settings: SearchSettingsConfig): SearchProviderId[] {
        return SEARCH_PROVIDER_IDS.filter((provider) =>
            isConfiguredSearchProvider(provider, settings)
        );
    }

    return { getAvailableSearchProviders, getSearchProviderAdapter, isConfiguredSearchProvider };
}
