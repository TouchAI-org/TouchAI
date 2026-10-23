import { describe, expect, it, vi } from 'vitest';

import { initializeSearchViewForFirstPaint } from '@/views/SearchView/startup';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

describe('when the search view opens for the first time', () => {
    it('user sees the search bar before the popup and MCP warmup finish', async () => {
        const popupWarmup = deferred();
        const mcpWarmup = deferred();
        const readyStates: boolean[] = [];

        await initializeSearchViewForFirstPaint({
            initializeSettings: vi.fn(async () => undefined),
            initializeMcpStore: vi.fn(() => mcpWarmup.promise),
            initializePopups: vi.fn(() => popupWarmup.promise),
            syncWindowPinState: vi.fn(async () => undefined),
            syncSearchWindowState: vi.fn(async () => undefined),
            isE2eTestMode: vi.fn(async () => true),
            autoConnectMcp: vi.fn(async () => undefined),
            onReady: (ready) => readyStates.push(ready),
        });

        expect(readyStates).toEqual([false, true]);

        popupWarmup.resolve();
        mcpWarmup.resolve();
    });

    it('user gets no search bar when the settings cannot be loaded', async () => {
        const error = new Error('settings failed');
        const logError = vi.fn();
        const readyStates: boolean[] = [];

        await initializeSearchViewForFirstPaint({
            initializeSettings: vi.fn(async () => {
                throw error;
            }),
            initializeMcpStore: vi.fn(async () => undefined),
            initializePopups: vi.fn(async () => undefined),
            syncWindowPinState: vi.fn(async () => undefined),
            syncSearchWindowState: vi.fn(async () => undefined),
            isE2eTestMode: vi.fn(async () => true),
            autoConnectMcp: vi.fn(async () => undefined),
            onReady: (ready) => readyStates.push(ready),
            logError,
        });

        expect(readyStates).toEqual([false, false]);
        expect(logError).toHaveBeenCalledWith(
            '[SearchView] Failed to initialize dependencies:',
            error
        );
    });
});
