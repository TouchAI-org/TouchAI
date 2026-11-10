import { runInNewContext } from 'node:vm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForE2eBridge } from '../../e2e-tests/test/support/desktop.js';

function createRenderer(windowLabel, bridgeReady = true) {
    return {
        window: {
            __TOUCHAI_E2E__: bridgeReady ? {} : undefined,
            __TAURI_INTERNALS__: windowLabel
                ? {
                      metadata: { currentWindow: { label: windowLabel } },
                      invoke: async () => null,
                  }
                : undefined,
        },
        document: {
            readyState: 'complete',
            visibilityState: 'visible',
            querySelector: () => null,
        },
        location: { pathname: '/' },
        innerWidth: 750,
        innerHeight: 60,
        devicePixelRatio: 1,
    };
}

function createSession(windows, initialHandle) {
    let currentHandle = initialHandle;
    const session = {
        async getWindowHandle() {
            return currentHandle;
        },
        async getWindowHandles() {
            return Object.keys(windows);
        },
        async switchToWindow(handle) {
            if (!windows[handle]) throw new Error(`No such window: ${handle}`);
            currentHandle = handle;
        },
        async execute(script, ...args) {
            return runInNewContext(`(${script.toString()})(...args)`, {
                ...windows[currentHandle],
                args,
                setTimeout,
                clearTimeout,
            });
        },
        async waitUntil(condition, { timeout, timeoutMsg }) {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                if (await condition()) return;
                await vi.advanceTimersByTimeAsync(Math.min(100, deadline - Date.now()));
            }
            throw new Error(timeoutMsg);
        },
    };
    vi.stubGlobal('browser', session);
    return session;
}

describe('desktop startup with multiple native windows', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('user given the main window is already ready when startup is awaited then stays on that window', async () => {
        const session = createSession({ search: createRenderer('main') }, 'search');

        await waitForE2eBridge();

        expect(await session.getWindowHandle()).toBe('search');
    });

    it.each([
        { surface: 'tray', label: 'tray-menu', bridgeReady: false },
        { surface: 'settings', label: 'settings', bridgeReady: true },
        { surface: 'blank', label: undefined, bridgeReady: false },
    ])(
        'user given the $surface window is current when startup is awaited then reaches the main window',
        async ({ label, bridgeReady }) => {
            const session = createSession(
                {
                    initial: createRenderer(label, bridgeReady),
                    search: createRenderer('main'),
                },
                'initial'
            );

            await waitForE2eBridge();

            expect(await session.getWindowHandle()).toBe('search');
        }
    );

    it('user given the main window appears later when startup is awaited then reaches it after creation', async () => {
        const windows = { initial: createRenderer('tray-menu', false) };
        const session = createSession(windows, 'initial');
        setTimeout(() => {
            windows.search = createRenderer('main');
        }, 100);

        await waitForE2eBridge();

        expect(await session.getWindowHandle()).toBe('search');
    });

    it('user given the main window is loading when startup is awaited then proceeds only after it is ready', async () => {
        const mainRenderer = createRenderer('main', false);
        const session = createSession({ search: mainRenderer }, 'search');
        setTimeout(() => {
            mainRenderer.window.__TOUCHAI_E2E__ = {};
        }, 100);

        await waitForE2eBridge();

        expect(await session.getWindowHandle()).toBe('search');
        expect(mainRenderer.window.__TOUCHAI_E2E__).toBeDefined();
    });

    it('user given only a different window is ready when startup is awaited then receives a readiness failure', async () => {
        createSession({ initial: createRenderer('settings') }, 'initial');

        await expect(waitForE2eBridge()).rejects.toThrow(
            'TouchAI E2E bridge did not become available in the renderer.'
        );
    });

    it('user given the main window never becomes ready when startup is awaited then gets its diagnostics at the original deadline', async () => {
        createSession(
            {
                initial: createRenderer('settings'),
                search: createRenderer('main', false),
            },
            'initial'
        );
        const startedAt = Date.now();

        await expect(waitForE2eBridge()).rejects.toThrow('"windowLabel":"main"');

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15000);
        expect(Date.now() - startedAt).toBeLessThan(16000);
    });
});
