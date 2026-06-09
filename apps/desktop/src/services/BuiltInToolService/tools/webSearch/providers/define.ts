import { SEARCH_PROVIDER_METADATA, type SearchProviderId } from '@/stores/setting/sections/search';

import type { WebSearchProviderAdapter } from './types';

function requiresApiKey(provider: SearchProviderId): boolean {
    return SEARCH_PROVIDER_METADATA[provider].apiKeyRequirement === 'required';
}

function requiresEndpoint(provider: SearchProviderId): boolean {
    return SEARCH_PROVIDER_METADATA[provider].endpointRequirement === 'required';
}

export function createSearchProviderAdapter(
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
