import { inject, type InjectionKey } from 'vue';

import type { BrowserSettingsConfig, SearchSettingsConfig } from '@/modules/tools/public';

import type { BrowserSettingsApi } from './browser';

export type {
    BrowserDomainRule,
    BrowserFingerprintMode,
    BrowserFingerprintProfile,
    BrowserPermissionMode,
    BrowserPermissionProfile,
    BrowserSettingsConfig,
    ExistingSessionPolicy,
    ScreenshotAttachmentMode,
    SearchProviderConfig,
    SearchProviderId,
    SearchRouteIntent,
    SearchSettingsConfig,
} from '@/modules/tools/public';
export {
    BROWSER_SETTINGS_KEY,
    BROWSER_SETTINGS_VERSION,
    DEFAULT_BROWSER_SETTINGS,
    DEFAULT_SEARCH_SETTINGS,
    getDefaultHomepageError,
    normalizeFingerprintWindowSize,
    parseBrowserSettingsConfig,
    parseSearchSettingsConfig,
    SEARCH_PROVIDER_API_KEY_REQUIREMENTS,
    SEARCH_PROVIDER_ENDPOINT_REQUIREMENTS,
    SEARCH_PROVIDER_IDS,
    SEARCH_PROVIDER_METADATA,
    SEARCH_ROUTE_INTENTS,
    SEARCH_SETTINGS_KEY,
    SEARCH_SETTINGS_VERSION,
    serializeBrowserSettingsConfig,
    serializeSearchSettingsConfig,
} from '@/modules/tools/public';

/** Installed only in the native settings window, never in ordinary preference clients. */
export interface ToolSettingsApi extends BrowserSettingsApi {
    pickBashWorkingDirectory(defaultPath?: string): Promise<string | null>;
    initialize(): Promise<void>;
    refresh(): Promise<void>;
    getBrowserSettings(): BrowserSettingsConfig;
    getSearchSettings(): SearchSettingsConfig;
    updateBrowserSettings(value: BrowserSettingsConfig): Promise<void>;
    updateSearchSettings(value: SearchSettingsConfig): Promise<void>;
    subscribe(listener: () => void): () => void;
}

export const toolSettingsApiKey: InjectionKey<ToolSettingsApi> = Symbol('touchai.settings.tools');
export function useToolSettingsApi(): ToolSettingsApi {
    const api = inject(toolSettingsApiKey);
    if (!api) throw new Error('TOOLS_SETTINGS_CLIENT_UNAVAILABLE');
    return api;
}

export type {
    SearchFetchProvider,
    SearchRoutingStrategy,
    SearchSource,
    WebFetchStrategy,
} from '@/modules/tools/public';
export {
    isSearchProviderReady,
    resolveSearchSourceProviders,
    SEARCH_FETCH_PROVIDERS,
    SEARCH_PARALLEL_MAX,
    SEARCH_ROUTING_STRATEGIES,
    SEARCH_SOURCES,
    WEB_FETCH_STRATEGIES,
} from '@/modules/tools/public';
