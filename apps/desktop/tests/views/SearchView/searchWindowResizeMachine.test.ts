import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { SearchWindowHeightMode } from '@/config/searchWindow';
import { useSearchWindowResize } from '@/views/SearchView/composables/useSearchWindowResize';

/**
 * The resize state machine decides the native window geometry. The Tauri window
 * and the native bridge are the process boundary and are stubbed; every
 * assertion below is about the geometry the window ends up with, given real DOM
 * height changes reported through the ResizeObserver.
 */
const { currentWindowMock, nativeMock } = vi.hoisted(() => ({
    currentWindowMock: {
        isVisible: vi.fn(),
        isMaximized: vi.fn(),
        maximize: vi.fn(),
        unmaximize: vi.fn(),
        onResized: vi.fn(),
    },
    nativeMock: {
        window: {
            getSearchWindowState: vi.fn(),
            resizeWindowHeight: vi.fn(),
            resetSearchWindowBounds: vi.fn(),
            setSearchWindowAllowHeightOverride: vi.fn(),
            setSearchWindowDefaults: vi.fn(),
            setSearchWindowMinSize: vi.fn(),
        },
    },
}));

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => currentWindowMock }));
vi.mock('@services/NativeService', () => ({ native: nativeMock }));

class ResizeObserverMock {
    static instances: ResizeObserverMock[] = [];

    callback: ResizeObserverCallback;
    observed: Element[] = [];
    disconnected = false;

    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        ResizeObserverMock.instances.push(this);
    }

    observe(element: Element) {
        this.observed.push(element);
    }

    disconnect() {
        this.disconnected = true;
    }

    /** Reports the element's current measured height, exactly as the browser would. */
    emitCurrentHeight() {
        const target = this.observed[0] as HTMLElement;
        this.callback(
            [
                {
                    target,
                    borderBoxSize: [{ blockSize: target.getBoundingClientRect().height }],
                    contentRect: target.getBoundingClientRect(),
                } as unknown as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver
        );
    }
}

function createMeasuredElement(height: number) {
    const element = document.createElement('div');
    let measured = height;

    for (const key of ['clientHeight', 'scrollHeight', 'offsetHeight'] as const) {
        Object.defineProperty(element, key, { configurable: true, get: () => measured });
    }

    element.getBoundingClientRect = () =>
        ({
            width: 600,
            height: measured,
            top: 0,
            left: 0,
            right: 600,
            bottom: measured,
            x: 0,
            y: 0,
            toJSON: () => undefined,
        }) as DOMRect;

    return {
        element,
        setHeight(value: number) {
            measured = value;
        },
    };
}

async function flushResizeLifecycle() {
    for (let index = 0; index < 6; index += 1) {
        await Promise.resolve();
        await nextTick();
    }
}

/** Shrinking is coalesced behind an 80ms settle window before it reaches the window. */
async function waitForCoalesce() {
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flushResizeLifecycle();
}

/** The most recent observer is the one attached to the current content root. */
function latestObserver(): ResizeObserverMock {
    return ResizeObserverMock.instances[ResizeObserverMock.instances.length - 1]!;
}

beforeEach(() => {
    vi.clearAllMocks();
    ResizeObserverMock.instances = [];
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });

    currentWindowMock.isVisible.mockResolvedValue(true);
    currentWindowMock.isMaximized.mockResolvedValue(false);
    currentWindowMock.maximize.mockResolvedValue(undefined);
    currentWindowMock.unmaximize.mockResolvedValue(undefined);
    currentWindowMock.onResized.mockImplementation(async () => () => undefined);

    nativeMock.window.getSearchWindowState.mockResolvedValue({
        defaults: { width: 750, height: 60 },
        currentWidth: 750,
        currentHeight: 60,
        heightMode: SearchWindowHeightMode.Auto,
    });
    nativeMock.window.resizeWindowHeight.mockResolvedValue(undefined);
    nativeMock.window.resetSearchWindowBounds.mockResolvedValue(undefined);
    nativeMock.window.setSearchWindowAllowHeightOverride.mockResolvedValue(undefined);
    nativeMock.window.setSearchWindowDefaults.mockImplementation(async (defaults) => defaults);
    nativeMock.window.setSearchWindowMinSize.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

function mountResize(
    options: Partial<{
        target: HTMLElement | null;
        sessionCount: number;
        quickSearchOpen: boolean;
        defaultSize: { width: number; height: number };
        ready: boolean;
    }> = {}
) {
    return mountComposable(() =>
        useSearchWindowResize({
            target: ref(options.target ?? null),
            sessionCount: ref(options.sessionCount ?? 1),
            quickSearchOpen: ref(options.quickSearchOpen ?? false),
            defaultSize: ref(options.defaultSize ?? { width: 750, height: 60 }),
            ready: ref(options.ready ?? true),
        })
    );
}

describe('when the observed content grows and shrinks', () => {
    it('user gets the window following taller content straight away', async () => {
        const target = createMeasuredElement(180);
        const mounted = await mountResize({ target: target.element });
        await flushResizeLifecycle();
        vi.clearAllMocks();

        target.setHeight(400);
        latestObserver().emitCurrentHeight();
        await flushResizeLifecycle();

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith(
            expect.objectContaining({ targetHeight: 400 })
        );

        mounted.unmount();
    });

    it('user gets a burst of shrinking content collapsed into one resize', async () => {
        const target = createMeasuredElement(400);
        const mounted = await mountResize({ target: target.element });
        await flushResizeLifecycle();

        const observer = latestObserver();
        vi.clearAllMocks();

        // Deleting several lines in a row: each report shrinks the box further.
        target.setHeight(300);
        observer.emitCurrentHeight();
        target.setHeight(280);
        observer.emitCurrentHeight();
        target.setHeight(260);
        observer.emitCurrentHeight();
        await waitForCoalesce();

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledTimes(1);
        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith(
            expect.objectContaining({ targetHeight: 260 })
        );

        mounted.unmount();
    });
});

describe('when the window reports a resize from the OS', () => {
    it('user gets the native state re-read after the window was resized', async () => {
        let resizeHandler: (() => void) | null = null;
        currentWindowMock.onResized.mockImplementation(async (handler: () => void) => {
            resizeHandler = handler;
            return () => undefined;
        });

        const mounted = await mountResize();
        await flushResizeLifecycle();
        nativeMock.window.getSearchWindowState.mockClear();

        resizeHandler!();
        await flushResizeLifecycle();

        expect(nativeMock.window.getSearchWindowState).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets no state read before the view is ready', async () => {
        let resizeHandler: (() => void) | null = null;
        currentWindowMock.onResized.mockImplementation(async (handler: () => void) => {
            resizeHandler = handler;
            return () => undefined;
        });

        const mounted = await mountResize({ ready: false });
        await flushResizeLifecycle();
        nativeMock.window.getSearchWindowState.mockClear();

        resizeHandler!();
        await flushResizeLifecycle();

        expect(nativeMock.window.getSearchWindowState).not.toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the window is maximized and restored', () => {
    it('user gets the conversation measured again after restoring from maximized', async () => {
        const target = createMeasuredElement(300);
        currentWindowMock.maximize.mockImplementation(async () => {
            currentWindowMock.isMaximized.mockResolvedValue(true);
        });
        currentWindowMock.unmaximize.mockImplementation(async () => {
            currentWindowMock.isMaximized.mockResolvedValue(false);
        });

        const mounted = await mountResize({ target: target.element });
        await flushResizeLifecycle();

        await mounted.result.toggleMaximize();
        await flushResizeLifecycle();
        expect(mounted.result.isMaximized.value).toBe(true);

        vi.clearAllMocks();
        target.setHeight(360);
        await mounted.result.toggleMaximize();
        await flushResizeLifecycle();

        expect(mounted.result.isMaximized.value).toBe(false);
        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith(
            expect.objectContaining({ targetHeight: 360 })
        );

        mounted.unmount();
    });

    it('user gets no second maximize while the window is still animating open', async () => {
        let finishMaximize: (() => void) | null = null;
        let maximizeCount = 0;

        currentWindowMock.maximize.mockImplementation(() => {
            maximizeCount += 1;
            return new Promise<void>((resolve) => {
                finishMaximize = () => {
                    currentWindowMock.isMaximized.mockResolvedValue(true);
                    resolve();
                };
            });
        });

        const mounted = await mountResize({ sessionCount: 1 });
        await flushResizeLifecycle();

        const firstToggle = mounted.result.toggleMaximize();
        const secondToggle = mounted.result.toggleMaximize();
        // The window is treated as maximized while it animates, so no second open starts.
        expect(mounted.result.effectiveWindowMaximized.value).toBe(true);

        await flushResizeLifecycle();
        finishMaximize!();
        await Promise.all([firstToggle, secondToggle]);
        await flushResizeLifecycle();

        expect(maximizeCount).toBe(1);
        expect(mounted.result.isMaximized.value).toBe(true);

        mounted.unmount();
    });

    it('user gets the window restored from maximized when the conversation closes', async () => {
        const sessionCount = ref(1);
        currentWindowMock.maximize.mockImplementation(async () => {
            currentWindowMock.isMaximized.mockResolvedValue(true);
        });
        currentWindowMock.unmaximize.mockImplementation(async () => {
            currentWindowMock.isMaximized.mockResolvedValue(false);
        });

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref<HTMLElement | null>(null),
                sessionCount,
                quickSearchOpen: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready: ref(true),
            })
        );
        await flushResizeLifecycle();

        await mounted.result.toggleMaximize();
        await flushResizeLifecycle();
        expect(mounted.result.isMaximized.value).toBe(true);

        sessionCount.value = 0;
        await flushResizeLifecycle();
        await mounted.result.toggleMaximize();
        await flushResizeLifecycle();

        // The idle search bar may never stay maximized.
        expect(currentWindowMock.unmaximize).toHaveBeenCalled();
        expect(mounted.result.isMaximized.value).toBe(false);

        mounted.unmount();
    });
});

describe('when the search view becomes ready late', () => {
    it('user gets the window constraints applied only once the view is ready', async () => {
        const ready = ref(false);
        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref<HTMLElement | null>(null),
                sessionCount: ref(0),
                quickSearchOpen: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        await flushResizeLifecycle();
        expect(nativeMock.window.setSearchWindowDefaults).not.toHaveBeenCalled();
        expect(mounted.result.contentReady.value).toBe(false);

        ready.value = true;
        await flushResizeLifecycle();

        expect(nativeMock.window.setSearchWindowDefaults).toHaveBeenCalledWith({
            width: 750,
            height: 60,
        });
        expect(mounted.result.contentReady.value).toBe(true);

        mounted.unmount();
    });

    it('user gets the constraints re-applied when only the width changes', async () => {
        const defaultSize = ref({ width: 750, height: 60 });
        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref<HTMLElement | null>(null),
                sessionCount: ref(0),
                quickSearchOpen: ref(false),
                defaultSize,
                ready: ref(true),
            })
        );
        await flushResizeLifecycle();
        vi.clearAllMocks();

        defaultSize.value = { width: 900, height: 60 };
        await flushResizeLifecycle();

        expect(nativeMock.window.setSearchWindowDefaults).toHaveBeenCalledWith({
            width: 900,
            height: 60,
        });

        mounted.unmount();
    });

    it('user gets no redundant defaults call when the size did not change', async () => {
        const defaultSize = ref({ width: 750, height: 60 });
        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref<HTMLElement | null>(null),
                sessionCount: ref(0),
                quickSearchOpen: ref(false),
                defaultSize,
                ready: ref(true),
            })
        );
        await flushResizeLifecycle();
        vi.clearAllMocks();

        defaultSize.value = { width: 750, height: 60 };
        await flushResizeLifecycle();

        expect(nativeMock.window.setSearchWindowDefaults).not.toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the target element changes or disappears', () => {
    it('user gets the old element unobserved when the page swaps the content root', async () => {
        const first = createMeasuredElement(180);
        const second = createMeasuredElement(240);
        const target = ref<HTMLElement | null>(first.element);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target,
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready: ref(true),
            })
        );
        await flushResizeLifecycle();
        const firstObserver = latestObserver();

        target.value = second.element;
        await flushResizeLifecycle();

        expect(firstObserver.disconnected).toBe(true);
        expect(latestObserver().observed).toEqual([second.element]);

        mounted.unmount();
    });

    it('user gets the observed element released when the content root is removed', async () => {
        const first = createMeasuredElement(180);
        const target = ref<HTMLElement | null>(first.element);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target,
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready: ref(true),
            })
        );
        await flushResizeLifecycle();
        const observer = latestObserver();

        target.value = null;
        await flushResizeLifecycle();

        expect(observer.disconnected).toBe(true);

        mounted.unmount();
    });
});

describe('when native calls fail', () => {
    it('user keeps the window usable when reading the maximize state fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        currentWindowMock.isMaximized.mockRejectedValue(new Error('no window handle'));

        const mounted = await mountResize({ sessionCount: 1 });
        await flushResizeLifecycle();

        expect(mounted.result.isMaximized.value).toBe(false);

        mounted.unmount();
    });

    it('user still gets the resize when the visibility probe fails', async () => {
        currentWindowMock.isVisible.mockRejectedValue(new Error('no window handle'));
        const target = createMeasuredElement(180);
        const mounted = await mountResize({ target: target.element });
        await flushResizeLifecycle();
        vi.clearAllMocks();

        target.setHeight(300);
        await mounted.result.remeasureTargetHeight();

        // A failed visibility probe must not silently block the resize.
        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith(
            expect.objectContaining({ targetHeight: 300 })
        );

        mounted.unmount();
    });

    it('user gets the window still initialised when the resize listener cannot be attached', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        currentWindowMock.onResized.mockRejectedValue(new Error('listener unavailable'));

        const mounted = await mountResize();
        await flushResizeLifecycle();

        // Losing the OS resize feed must not stop the initial geometry from being applied.
        expect(nativeMock.window.setSearchWindowDefaults).toHaveBeenCalledWith({
            width: 750,
            height: 60,
        });
        expect(nativeMock.window.setSearchWindowMinSize).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets the same height skipped twice so the window does not flicker', async () => {
        const target = createMeasuredElement(180);
        const mounted = await mountResize({ target: target.element });
        await flushResizeLifecycle();
        vi.clearAllMocks();

        // A second report of the height already applied must not reach the window again.
        const observer = latestObserver();
        target.setHeight(260);
        observer.emitCurrentHeight();
        await waitForCoalesce();
        observer.emitCurrentHeight();
        await waitForCoalesce();

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });
});

describe('when the user shrinks the window below the current floor', () => {
    it('user gets the native minimum lowered before the shrink so Windows accepts it', async () => {
        const target = createMeasuredElement(400);
        const mounted = await mountResize({ target: target.element });
        await flushResizeLifecycle();
        vi.clearAllMocks();

        target.setHeight(200);
        latestObserver().emitCurrentHeight();
        await waitForCoalesce();

        expect(nativeMock.window.setSearchWindowMinSize).toHaveBeenCalledWith(
            expect.objectContaining({ minHeight: 200 })
        );
        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith(
            expect.objectContaining({ targetHeight: 200 })
        );

        mounted.unmount();
    });
});
