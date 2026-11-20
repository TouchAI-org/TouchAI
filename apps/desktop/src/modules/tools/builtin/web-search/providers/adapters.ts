import {
    isSearchProviderReady,
    SEARCH_PROVIDER_IDS,
    type SearchProviderId,
    type SearchSettingsConfig,
} from '../configuration';
import { anySearchAdapter } from './anysearch';
import { braveAdapter } from './brave';
import { createDeepSeekSearchAdapter } from './deepseek';
import { doubaoAdapter } from './doubao';
import { exaAdapter } from './exa';
import { firecrawlAdapter } from './firecrawl';
import { githubAdapter } from './github';
import { grokAdapter } from './grok';
import { keenableAdapter } from './keenable';
import { openAlexAdapter } from './openalex';
import { qianfanAdapter } from './qianfan';
import { searxngAdapter } from './searxng';
import { semanticScholarAdapter } from './semanticScholar';
import { serperAdapter } from './serper';
import { tavilyAdapter } from './tavily';
import { tinyfishAdapter } from './tinyfish';
import type { WebSearchProviderAdapter } from './types';
import { wikipediaAdapter } from './wikipedia';
import { yuanbaoAdapter } from './yuanbao';
import { zhihuAdapter } from './zhihu';

export function createSearchProviders() {
    function isConcreteProviderConfigured(
        provider: SearchProviderId,
        settings: SearchSettingsConfig
    ): boolean {
        return isSearchProviderReady(provider, settings.providers[provider]);
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
        keenableAdapter,
        zhihuAdapter,
        yuanbaoAdapter,
        grokAdapter,
        doubaoAdapter,
        qianfanAdapter,
        tinyfishAdapter,
        serperAdapter,
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
