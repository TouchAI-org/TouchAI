import { inject, type InjectionKey } from 'vue';

import type { ProductAnalytics } from '@/modules/analytics/public';

export type {
    ProductAnalytics,
    ProviderConfigurationAttempt,
    SearchInteraction,
} from '@/modules/analytics/public';
export { mapProviderCategory, mapSearchSurfaceSource } from '@/modules/analytics/public';

export const productAnalyticsApiKey: InjectionKey<ProductAnalytics> = Symbol(
    'touchai.analytics.product'
);

export function useProductAnalyticsApi(): ProductAnalytics {
    const api = inject(productAnalyticsApiKey);
    if (!api) throw new Error('PRODUCT_ANALYTICS_UNAVAILABLE');
    return api;
}
