import type {
    SearchSurfaceHiddenEvent,
    SearchSurfaceShownEvent,
} from '@services/EventService/types';
import type { SearchSurfacePreparation } from '@services/NativeService/types';
import { describe, expect, it, vi } from 'vitest';

import {
    createSearchSurfacePreparationController,
    type SearchSurfacePreparationControllerOptions,
} from '@/views/SearchView/searchSurfacePreparation';

type Handler<Payload> = (payload: Payload) => void | Promise<void>;

function deferred<Value>() {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

function createHarness() {
    const prepareHandlers = new Set<Handler<SearchSurfacePreparation>>();
    const shownHandlers = new Set<Handler<SearchSurfaceShownEvent>>();
    const hiddenHandlers = new Set<Handler<SearchSurfaceHiddenEvent>>();
    const shownFacts: SearchSurfaceShownEvent[] = [];
    const hiddenFacts: SearchSurfaceHiddenEvent[] = [];
    let registrations = 0;

    function register<Payload>(handlers: Set<Handler<Payload>>, handler: Handler<Payload>) {
        registrations += 1;
        handlers.add(handler);
        return Promise.resolve(() => {
            handlers.delete(handler);
        });
    }

    const options: SearchSurfacePreparationControllerOptions = {
        listenPrepare: (handler) => register(prepareHandlers, handler),
        listenShown: (handler) => register(shownHandlers, handler),
        listenHidden: (handler) => register(hiddenHandlers, handler),
        getRendererEpoch: vi.fn(async () => 2),
        markRendererReady: vi.fn(async () => null),
        getViewport: async () => ({
            physicalViewport: { x: 0, y: 0, width: 750, height: 60 },
            scaleFactor: 1,
        }),
        settle: async () => undefined,
        flush: vi.fn(async () => true),
        onShown: (value) => {
            shownFacts.push(value);
        },
        onHidden: (value) => {
            hiddenFacts.push(value);
        },
    };

    return {
        options,
        shownFacts,
        hiddenFacts,
        get registrations() {
            return registrations;
        },
        get activeListeners() {
            return prepareHandlers.size + shownHandlers.size + hiddenHandlers.size;
        },
        async emitShown(value: SearchSurfaceShownEvent) {
            await Promise.all([...shownHandlers].map((handler) => handler(value)));
        },
    };
}

const shown: SearchSurfaceShownEvent = {
    source: 'shortcut',
    sequence: 11,
    rendererEpoch: 2,
    showEpoch: 7,
    hostEpoch: 17,
    generation: 3,
};

describe('user prepares the search window', () => {
    it('user repeats startup requests and receives each native shown fact once', async () => {
        const harness = createHarness();
        const controller = createSearchSurfacePreparationController(harness.options);
        try {
            await Promise.all([controller.start(), controller.start()]);
            await controller.start();
            await harness.emitShown(shown);
            expect(harness.shownFacts).toEqual([shown]);
            expect(harness.activeListeners).toBe(3);
        } finally {
            controller.dispose();
        }
        expect(harness.activeListeners).toBe(0);
    });

    it('user requests startup after disposal without creating native work', async () => {
        const harness = createHarness();
        const controller = createSearchSurfacePreparationController(harness.options);
        controller.dispose();
        await expect(controller.start()).resolves.toBe(false);
        expect(harness.registrations).toBe(0);
        expect(harness.options.getRendererEpoch).not.toHaveBeenCalled();
    });

    it('user disposes while a native listener connects and no further subscriptions are requested', async () => {
        const harness = createHarness();
        const controller = createSearchSurfacePreparationController(harness.options);
        const listenPrepare = harness.options.listenPrepare;
        harness.options.listenPrepare = (handler) => {
            const registration = listenPrepare(handler);
            controller.dispose();
            return registration;
        };

        await expect(controller.start()).resolves.toBe(false);
        expect(harness.registrations).toBe(1);
        expect(harness.activeListeners).toBe(0);
        expect(harness.options.getRendererEpoch).not.toHaveBeenCalled();
    });

    it.each(['synchronously', 'asynchronously'] as const)(
        'user retries a subscription that failed %s without retaining partial listeners',
        async (failureTiming) => {
            const harness = createHarness();
            const failure = new Error('native subscription failed');
            const listenShown = vi.fn(harness.options.listenShown);
            if (failureTiming === 'synchronously') {
                listenShown.mockImplementationOnce(() => {
                    throw failure;
                });
            } else {
                listenShown.mockRejectedValueOnce(failure);
            }
            harness.options.listenShown = listenShown;
            const controller = createSearchSurfacePreparationController(harness.options);
            try {
                await expect(controller.start()).rejects.toBe(failure);
                expect(harness.activeListeners).toBe(0);
                await expect(controller.start()).resolves.toBe(false);
                await harness.emitShown(shown);
                expect(harness.shownFacts).toEqual([shown]);
                expect(harness.activeListeners).toBe(3);
            } finally {
                controller.dispose();
            }
        }
    );

    it('user retries after a failed connection without accepting its late handles or window events', async () => {
        const harness = createHarness();
        const registration = deferred<() => void>();
        const releaseLateHandle = vi.fn();
        let queuedHidden!: Handler<SearchSurfaceHiddenEvent>;
        harness.options.listenShown = vi
            .fn(harness.options.listenShown)
            .mockRejectedValueOnce(new Error('shown subscription failed'));
        harness.options.listenHidden = vi
            .fn(harness.options.listenHidden)
            .mockImplementationOnce((handler) => {
                queuedHidden = handler;
                return registration.promise;
            });
        const controller = createSearchSurfacePreparationController(harness.options);
        try {
            await expect(controller.start()).rejects.toThrow('shown subscription failed');
            await controller.start();
            registration.resolve(releaseLateHandle);
            await Promise.resolve();
            await Promise.resolve();
            await queuedHidden({ reason: 'manual-dismiss', sequence: 12 });
            expect(releaseLateHandle).toHaveBeenCalledOnce();
            expect(harness.hiddenFacts).toEqual([]);
            expect(harness.activeListeners).toBe(3);
        } finally {
            registration.resolve(releaseLateHandle);
            controller.dispose();
        }
    });

    it('user reenters startup while a native listener connects without duplicating subscriptions', async () => {
        const harness = createHarness();
        const listenPrepare = harness.options.listenPrepare;
        let nestedStart: Promise<boolean> | undefined;
        let reentered = false;
        const controller = createSearchSurfacePreparationController(harness.options);
        harness.options.listenPrepare = (handler) => {
            const registration = listenPrepare(handler);
            if (!reentered) {
                reentered = true;
                nestedStart = controller.start();
            }
            return registration;
        };
        try {
            await controller.start();
            await nestedStart;
            await harness.emitShown(shown);
            expect(harness.shownFacts).toEqual([shown]);
            expect(harness.activeListeners).toBe(3);
        } finally {
            controller.dispose();
        }
    });
});
