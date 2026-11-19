import { afterEach } from 'vitest';
import type { App } from 'vue';

import { productAnalyticsApiKey } from '@/app/api/analytics/product';
import { assembleAnalyticsWindow } from '@/app/composition/analytics';

const windows = new Set<ReturnType<typeof assembleAnalyticsWindow>>();
export function createTestAnalyticsWindow(label = 'main') {
    const window = assembleAnalyticsWindow(label);
    windows.add(window);
    return window;
}
export function provideTestAnalytics(app: App) {
    app.provide(productAnalyticsApiKey, createTestAnalyticsWindow().product);
}
afterEach(() => {
    for (const window of windows) window.dispose();
    windows.clear();
});
