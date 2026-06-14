import type {
    SearchProviderConfig,
    SearchProviderId,
    SearchSettingsConfig,
} from '@/stores/setting/sections/search';

import type { WebSearchRequest, WebSearchResult } from '../helper';

export type WebSearchFetchJson = (
    url: URL,
    signal: AbortSignal,
    init?: {
        method?: 'GET' | 'POST';
        headers?: Record<string, string>;
        body?: string;
    }
) => Promise<unknown>;

export interface WebSearchProviderAdapter {
    id: SearchProviderId;
    isConfigured(config: SearchProviderConfig): boolean;
    search(params: {
        request: WebSearchRequest;
        settings: SearchSettingsConfig;
        signal: AbortSignal;
        fetchJson: WebSearchFetchJson;
    }): Promise<WebSearchResult[]>;
}
