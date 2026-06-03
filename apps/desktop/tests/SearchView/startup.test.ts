import { describe, expect, it, vi } from 'vitest';

import { initializeSearchViewForFirstPaint } from '@/views/SearchView/startup';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

describe('initializeSearchViewForFirstPaint', () => {
    it('marks the view ready after settings initialize without waiting for popup or MCP warmup', async () => {
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

    it('keeps the view hidden when the critical settings load fails', async () => {
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
