import type { createProductAnalytics } from './productInteractions';

export type * from './lifecycle';
export type { ProviderConfigurationAttempt, SearchInteraction } from './productInteractions';
export { mapProviderCategory, mapSearchSurfaceSource } from './productInteractions';
export type * from './types';
export { ANALYTICS_EVENT_NAMES } from './types';

export type ProductAnalytics = Pick<
    ReturnType<typeof createProductAnalytics>,
    | 'trackSurfaceOpened'
    | 'beginProviderConfigurationAttempt'
    | 'runProviderConfigurationAttempt'
    | 'runProviderConfiguration'
    | 'beginSearchInteraction'
    | 'settleSearchInteraction'
    | 'trackSearchFeatureExposed'
    | 'selectSearchResult'
    | 'finishSearchInteraction'
    | 'runResultAction'
>;

export interface AnalyticsChoice {
    status: 'uninitialized' | 'enabled' | 'disabled';
    consentEpoch: number;
    canEnable: boolean;
}

export interface AnalyticsPreferences {
    getChoice(): Promise<AnalyticsChoice>;
    setEnabled(enabled: boolean, expectedConsentEpoch: number): Promise<AnalyticsChoice>;
}
