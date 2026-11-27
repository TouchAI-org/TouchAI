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

// jsdom has no frame clock. Libraries that debounce through nested
// requestAnimationFrame calls (the editor does) schedule frames that outlive the
// file that stubbed the clock, so a global fallback keeps those callbacks from
// throwing after the stub is restored. A test that stubs the clock and then
// restores globals removes it again, so it is reinstalled after every test.
function installFrameClockFallback() {
    if (typeof globalThis.requestAnimationFrame !== 'undefined') return;
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: (callback: FrameRequestCallback) =>
            window.setTimeout(() => callback(performance.now()), 16),
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
        configurable: true,
        writable: true,
        value: (id: number) => window.clearTimeout(id),
    });
}

installFrameClockFallback();

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
    installFrameClockFallback();
});
