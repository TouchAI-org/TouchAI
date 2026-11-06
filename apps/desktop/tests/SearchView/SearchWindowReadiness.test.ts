import type {
    SearchSurfaceHiddenEvent,
    SearchSurfaceShownEvent,
} from '@services/EventService/types';
import type { SearchSurfacePreparation } from '@services/NativeService/types';
import { describe, expect, it, vi } from 'vitest';

import {
    createSearchSurfacePreparationController,
    type SearchSurfacePreparationControllerOptions,
    settleSearchSurfaceViewport,
} from '@/views/SearchView/searchSurfacePreparation';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

function preparation(
    showEpoch: number,
    viewport = { x: -1920, y: 0, width: 1920, height: 1040 }
): SearchSurfacePreparation {
    return {
        rendererEpoch: 2,
        showEpoch,
        hostEpoch: showEpoch + 10,
        source: 'shortcut',
        physicalViewport: viewport,
        scaleFactor: 1.25,
    };
}

function shownEvent(value: SearchSurfacePreparation, generation: number): SearchSurfaceShownEvent {
    return {
        source: value.source,
        sequence: generation + 100,
        rendererEpoch: value.rendererEpoch,
        showEpoch: value.showEpoch,
        hostEpoch: value.hostEpoch,
        generation,
    };
}

function createHarness(overrides: Partial<SearchSurfacePreparationControllerOptions> = {}) {
    let prepareHandler: ((payload: SearchSurfacePreparation) => void) | null = null;
    let shownHandler: ((payload: SearchSurfaceShownEvent) => void) | null = null;
    let hiddenHandler: ((payload: SearchSurfaceHiddenEvent) => void) | null = null;
    let viewport = {
        physicalViewport: { x: -1920, y: 0, width: 1920, height: 1040 },
        scaleFactor: 1.25,
    };
    const unlistenPrepare = vi.fn();
    const unlistenShown = vi.fn();
    const unlistenHidden = vi.fn();
    const options: SearchSurfacePreparationControllerOptions = {
        listenPrepare: vi.fn(async (handler) => {
            prepareHandler = handler;
            return unlistenPrepare;
        }),
        listenShown: vi.fn(async (handler) => {
            shownHandler = handler;
            return unlistenShown;
        }),
        listenHidden: vi.fn(async (handler) => {
            hiddenHandler = handler;
            return unlistenHidden;
        }),
        getRendererEpoch: vi.fn(async () => 2),
        markRendererReady: vi.fn(async () => null),
        getViewport: vi.fn(async () => viewport),
        settle: vi.fn(async () => undefined),
        flush: vi.fn(async () => true),
        onShown: vi.fn(),
        onHidden: vi.fn(),
        onError: vi.fn(),
        ...overrides,
    };

    return {
        options,
        emitPrepare(value: SearchSurfacePreparation) {
            expect(prepareHandler).not.toBeNull();
            prepareHandler!(value);
        },
        emitShown(value: SearchSurfaceShownEvent) {
            expect(shownHandler).not.toBeNull();
            shownHandler!(value);
        },
        emitHidden(value: SearchSurfaceHiddenEvent) {
            expect(hiddenHandler).not.toBeNull();
            hiddenHandler!(value);
        },
        setViewport(next: typeof viewport) {
            viewport = next;
        },
        unlisteners: [unlistenPrepare, unlistenShown, unlistenHidden],
    };
}

describe('search surface preparation controller', () => {
    it('does not mark the renderer ready until prepare, shown, and hidden listeners are installed', async () => {
        const prepareListener = deferred<() => void>();
        const shownListener = deferred<() => void>();
        const hiddenListener = deferred<() => void>();
        const markRendererReady = vi.fn(async () => null);
        const harness = createHarness({
            listenPrepare: vi.fn(async () => prepareListener.promise),
            listenShown: vi.fn(async () => shownListener.promise),
            listenHidden: vi.fn(async () => hiddenListener.promise),
            markRendererReady,
        });
        const controller = createSearchSurfacePreparationController(harness.options);

        const starting = controller.start();
        await Promise.resolve();
        expect(markRendererReady).not.toHaveBeenCalled();

        prepareListener.resolve(vi.fn());
        shownListener.resolve(vi.fn());
        await Promise.resolve();
        expect(markRendererReady).not.toHaveBeenCalled();

        hiddenListener.resolve(vi.fn());
        await starting;

        expect(markRendererReady).toHaveBeenCalledOnce();
        expect(markRendererReady).toHaveBeenCalledWith(2);
        controller.dispose();
    });

    it('reports no initial commit when mark-ready has no pending preparation', async () => {
        const harness = createHarness({
            markRendererReady: vi.fn(async () => null),
        });
        const controller = createSearchSurfacePreparationController(harness.options);

        await expect(controller.start()).resolves.toBe(false);
        expect(harness.options.flush).not.toHaveBeenCalled();
        expect(harness.options.onError).not.toHaveBeenCalled();
        controller.dispose();
    });

    it('waits for the expected physical viewport and settle before flushing the token', async () => {
        const settling = deferred<void>();
        const settle = vi.fn(() => settling.promise);
        const harness = createHarness({ settle });
        harness.setViewport({
            physicalViewport: { x: 0, y: 0, width: 750, height: 60 },
            scaleFactor: 1,
        });
        const controller = createSearchSurfacePreparationController(harness.options);
        await controller.start();
        const current = preparation(7);

        harness.emitPrepare(current);
        await Promise.resolve();
        await Promise.resolve();

        expect(settle).not.toHaveBeenCalled();
        expect(harness.options.flush).not.toHaveBeenCalled();

        harness.setViewport({
            physicalViewport: current.physicalViewport,
            scaleFactor: current.scaleFactor,
        });
        controller.notifyViewportChanged();
        await Promise.resolve();
        await Promise.resolve();

        expect(settle).toHaveBeenCalledOnce();
        expect(harness.options.flush).not.toHaveBeenCalled();

        settling.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(harness.options.flush).toHaveBeenCalledOnce();
        expect(harness.options.flush).toHaveBeenCalledWith(current);
        controller.dispose();
    });

    it('invalidates a deferred preparation when a newer preparation arrives', async () => {
        const firstSettle = deferred<void>();
        const secondSettle = deferred<void>();
        const settle = vi
            .fn<() => Promise<void>>()
            .mockImplementationOnce(() => firstSettle.promise)
            .mockImplementationOnce(() => secondSettle.promise);
        const harness = createHarness({ settle });
        const controller = createSearchSurfacePreparationController(harness.options);
        await controller.start();
        const first = preparation(7);
        const second = preparation(8);

        harness.emitPrepare(first);
        await Promise.resolve();
        await Promise.resolve();
        harness.emitPrepare(second);
        await Promise.resolve();
        await Promise.resolve();

        firstSettle.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(harness.options.flush).not.toHaveBeenCalledWith(first);

        secondSettle.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(harness.options.flush).toHaveBeenCalledOnce();
        expect(harness.options.flush).toHaveBeenCalledWith(second);
        controller.dispose();
    });

    it('invalidates a deferred preparation before forwarding a hidden fact', async () => {
        const settling = deferred<void>();
        const harness = createHarness({ settle: vi.fn(() => settling.promise) });
        const controller = createSearchSurfacePreparationController(harness.options);
        await controller.start();
        const current = preparation(7);
        harness.emitPrepare(current);
        await Promise.resolve();
        await Promise.resolve();
        const hidden: SearchSurfaceHiddenEvent = {
            reason: 'manual-dismiss',
            sequence: 30,
        };

        harness.emitHidden(hidden);
        settling.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(harness.options.flush).not.toHaveBeenCalled();
        expect(harness.options.onHidden).toHaveBeenCalledWith(hidden);
        controller.dispose();
    });

    it('invalidates deferred work and removes all listeners when disposed', async () => {
        const settling = deferred<void>();
        const harness = createHarness({ settle: vi.fn(() => settling.promise) });
        const controller = createSearchSurfacePreparationController(harness.options);
        await controller.start();
        harness.emitPrepare(preparation(7));
        await Promise.resolve();
        await Promise.resolve();

        controller.dispose();
        settling.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(harness.options.flush).not.toHaveBeenCalled();
        for (const unlisten of harness.unlisteners) expect(unlisten).toHaveBeenCalledOnce();
    });

    it('forwards a shown fact only after its listener is active', async () => {
        const harness = createHarness();
        const controller = createSearchSurfacePreparationController(harness.options);
        await controller.start();
        const shown = shownEvent(preparation(7), 17);

        harness.emitShown(shown);

        expect(harness.options.onShown).toHaveBeenCalledWith(shown);
        controller.dispose();
    });

    it('retries the current preparation when an ordinary region dispatch supersedes its flush', async () => {
        const flush = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const harness = createHarness({ flush });
        const controller = createSearchSurfacePreparationController(harness.options);
        await controller.start();
        const current = preparation(7);

        harness.emitPrepare(current);
        for (let index = 0; index < 12; index += 1) await Promise.resolve();

        expect(flush).toHaveBeenCalledTimes(2);
        expect(flush).toHaveBeenNthCalledWith(1, current);
        expect(flush).toHaveBeenNthCalledWith(2, current);
        controller.dispose();
    });

    it('does not finish startup until a returned pending preparation commits', async () => {
        const initial = preparation(7);
        const settling = deferred<void>();
        const harness = createHarness({
            markRendererReady: vi.fn(async () => initial),
            settle: vi.fn(() => settling.promise),
        });
        const controller = createSearchSurfacePreparationController(harness.options);
        let started = false;

        const starting = controller.start();
        void starting.then(() => {
            started = true;
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(started).toBe(false);
        expect(harness.options.flush).not.toHaveBeenCalled();

        settling.resolve();
        await expect(starting).resolves.toBe(true);

        expect(harness.options.flush).toHaveBeenCalledWith(initial);
        expect(started).toBe(true);
        controller.dispose();
    });

    it('reports cancellation without throwing when disposal wins a pending initial commit', async () => {
        const initial = preparation(7);
        const settling = deferred<void>();
        const harness = createHarness({
            markRendererReady: vi.fn(async () => initial),
            settle: vi.fn(() => settling.promise),
        });
        const controller = createSearchSurfacePreparationController(harness.options);
        const starting = controller.start();
        for (let index = 0; index < 4; index += 1) await Promise.resolve();

        controller.dispose();
        settling.resolve();

        await expect(starting).resolves.toBe(false);
        expect(harness.options.flush).not.toHaveBeenCalled();
        expect(harness.options.onError).not.toHaveBeenCalled();
    });

    it('reports cancellation without throwing when hidden wins a pending initial commit', async () => {
        const initial = preparation(7);
        const settling = deferred<void>();
        const harness = createHarness({
            markRendererReady: vi.fn(async () => initial),
            settle: vi.fn(() => settling.promise),
        });
        const controller = createSearchSurfacePreparationController(harness.options);
        const starting = controller.start();
        for (let index = 0; index < 6; index += 1) await Promise.resolve();
        const hidden: SearchSurfaceHiddenEvent = {
            reason: 'manual-dismiss',
            sequence: 31,
        };

        harness.emitHidden(hidden);
        settling.resolve();

        await expect(starting).resolves.toBe(false);
        expect(harness.options.flush).not.toHaveBeenCalled();
        expect(harness.options.onHidden).toHaveBeenCalledWith(hidden);
        expect(harness.options.onError).not.toHaveBeenCalled();
        controller.dispose();
    });

    it.each(['hidden', 'visible'] as const)(
        'can recall an occluded native window while document visibility is %s and rendering is suspended',
        async (state) => {
            vi.useFakeTimers();
            const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
            vi.stubGlobal(
                'requestAnimationFrame',
                vi.fn(() => 1)
            );
            const initial = preparation(7);
            const harness = createHarness({
                markRendererReady: vi.fn(async () => initial),
                settle: settleSearchSurfaceViewport,
            });
            const controller = createSearchSurfacePreparationController(harness.options);
            try {
                void controller.start();
                for (let index = 0; index < 30; index += 1) await Promise.resolve();
                expect(harness.options.flush).toHaveBeenCalledWith(initial);
            } finally {
                controller.dispose();
                visibility.mockRestore();
                vi.useRealTimers();
                vi.unstubAllGlobals();
            }
        }
    );

    it('keeps startup pending when a newer preparation supersedes the returned one', async () => {
        const initial = preparation(7);
        const latest = preparation(8);
        const initialSettle = deferred<void>();
        const latestSettle = deferred<void>();
        const harness = createHarness({
            markRendererReady: vi.fn(async () => initial),
            settle: vi
                .fn<() => Promise<void>>()
                .mockImplementationOnce(() => initialSettle.promise)
                .mockImplementationOnce(() => latestSettle.promise),
        });
        const controller = createSearchSurfacePreparationController(harness.options);
        let started = false;
        const starting = controller.start().then(() => {
            started = true;
        });
        for (let index = 0; index < 6; index += 1) await Promise.resolve();

        harness.emitPrepare(latest);
        initialSettle.resolve();
        for (let index = 0; index < 6; index += 1) await Promise.resolve();

        expect(started).toBe(false);
        expect(harness.options.flush).not.toHaveBeenCalledWith(initial);

        latestSettle.resolve();
        await starting;

        expect(harness.options.flush).toHaveBeenCalledWith(latest);
        expect(started).toBe(true);
        controller.dispose();
    });

    it('treats matching shown as success when it arrives before the flush promise settles', async () => {
        const initial = preparation(7);
        const flushResult = deferred<boolean>();
        const harness = createHarness({
            markRendererReady: vi.fn(async () => initial),
            flush: vi.fn(() => flushResult.promise),
        });
        const controller = createSearchSurfacePreparationController(harness.options);
        const starting = controller.start();
        for (let index = 0; index < 12; index += 1) await Promise.resolve();

        expect(harness.options.flush).toHaveBeenCalledOnce();
        const shown = shownEvent(initial, 17);
        harness.emitShown(shown);

        try {
            await expect(starting).resolves.toBe(true);
            expect(harness.options.onShown).toHaveBeenCalledWith(shown);
        } finally {
            flushResult.resolve(true);
            controller.dispose();
        }
    });

    it('reuses an authoritative shown fact when mark-ready returns the same token later', async () => {
        const initial = preparation(7);
        const markReadyResult = deferred<SearchSurfacePreparation | null>();
        const flush = vi.fn(async () => true);
        const harness = createHarness({
            markRendererReady: vi.fn(() => markReadyResult.promise),
            flush,
        });
        const controller = createSearchSurfacePreparationController(harness.options);
        const starting = controller.start();
        for (let index = 0; index < 6; index += 1) await Promise.resolve();

        harness.emitPrepare(initial);
        for (let index = 0; index < 12; index += 1) await Promise.resolve();
        expect(flush).toHaveBeenCalledOnce();

        harness.emitShown(shownEvent(initial, 17));
        markReadyResult.resolve(initial);

        await expect(starting).resolves.toBe(true);
        expect(flush).toHaveBeenCalledOnce();
        controller.dispose();
    });

    it('does not revive a preparation returned after hidden cancels the mark-ready request', async () => {
        const initial = preparation(7);
        const markReadyResult = deferred<SearchSurfacePreparation | null>();
        const firstFlush = deferred<boolean>();
        const flush = vi
            .fn<() => Promise<boolean>>()
            .mockReturnValueOnce(firstFlush.promise)
            .mockResolvedValueOnce(true);
        const harness = createHarness({
            markRendererReady: vi.fn(() => markReadyResult.promise),
            flush,
        });
        const controller = createSearchSurfacePreparationController(harness.options);
        const starting = controller.start();
        for (let index = 0; index < 6; index += 1) await Promise.resolve();

        harness.emitPrepare(initial);
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
        expect(flush).toHaveBeenCalledOnce();

        harness.emitHidden({ reason: 'manual-dismiss', sequence: 32 });
        markReadyResult.resolve(initial);

        try {
            await expect(starting).resolves.toBe(false);
            expect(flush).toHaveBeenCalledOnce();
            expect(harness.options.onError).not.toHaveBeenCalled();
        } finally {
            firstFlush.resolve(false);
            controller.dispose();
        }
    });

    it('immediately removes listeners whose registrations finish after disposal', async () => {
        const prepareRegistration = deferred<() => void>();
        const shownRegistration = deferred<() => void>();
        const hiddenRegistration = deferred<() => void>();
        const unlistenPrepare = vi.fn();
        const unlistenShown = vi.fn();
        const unlistenHidden = vi.fn();
        const harness = createHarness({
            listenPrepare: vi.fn(async () => prepareRegistration.promise),
            listenShown: vi.fn(async () => shownRegistration.promise),
            listenHidden: vi.fn(async () => hiddenRegistration.promise),
        });
        const controller = createSearchSurfacePreparationController(harness.options);
        const starting = controller.start();

        controller.dispose();
        prepareRegistration.resolve(unlistenPrepare);
        shownRegistration.resolve(unlistenShown);
        hiddenRegistration.resolve(unlistenHidden);
        await starting;

        expect(unlistenPrepare).toHaveBeenCalledOnce();
        expect(unlistenShown).toHaveBeenCalledOnce();
        expect(unlistenHidden).toHaveBeenCalledOnce();
    });
});
