import { inject, type InjectionKey } from 'vue';

import type { AnalyticsPreferences } from '@/modules/analytics/public';

export type { AnalyticsChoice, AnalyticsPreferences } from '@/modules/analytics/public';
export const analyticsPreferencesApiKey: InjectionKey<AnalyticsPreferences> = Symbol(
    'touchai.analytics.preferences'
);
export function useAnalyticsPreferencesApi(): AnalyticsPreferences {
    const api = inject(analyticsPreferencesApiKey);
    if (!api) throw new Error('ANALYTICS_PREFERENCES_UNAVAILABLE');
    return api;
}
