import { config } from '@vue/test-utils';
import { afterEach, beforeEach, vi } from 'vitest';

import { productAnalyticsApiKey } from '@/app/api/analytics/product';

import { createTestAnalyticsWindow } from '../utils/analyticsWindow';
import { installTauriMocks, resetTauriMocks } from '../utils/tauri';
import {
    createTestWindowPresentation,
    disposeTestWindowPresentations,
} from '../utils/windowPresentation';

const webStreamGlobals = {
    ReadableStream: globalThis.ReadableStream,
    TransformStream: globalThis.TransformStream,
    WritableStream: globalThis.WritableStream,
};

for (const [name, value] of Object.entries(webStreamGlobals)) {
    if (
        typeof value !== 'undefined' &&
        typeof (globalThis as Record<string, unknown>)[name] === 'undefined'
    ) {
        Object.defineProperty(globalThis, name, {
            configurable: true,
            writable: true,
            value,
        });
    }
}

beforeEach(async () => {
    installTauriMocks();
    (await createTestWindowPresentation()).install();
    Reflect.set(config.global.provide, productAnalyticsApiKey, createTestAnalyticsWindow().product);
});

afterEach(async () => {
    disposeTestWindowPresentations();
    await Promise.resolve();
    vi.restoreAllMocks();
    resetTauriMocks();
});
