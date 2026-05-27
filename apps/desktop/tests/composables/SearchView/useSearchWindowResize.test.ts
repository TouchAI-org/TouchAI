import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { SearchWindowHeightMode } from '@/config/searchWindow';
import { useSearchWindowResize } from '@/views/SearchView/composables/useSearchWindowResize';

const { currentWindowMock, nativeMock } = vi.hoisted(() => ({
    currentWindowMock: {
        isVisible: vi.fn(),
        isMaximized: vi.fn(),
        maximize: vi.fn(),
        unmaximize: vi.fn(),
        scaleFactor: vi.fn(),
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

const windowResizeListenerMock = vi.hoisted(() => ({
    callback: null as
        | ((event: {
              payload: {
                  width: number;
                  height: number;
                  toLogical: (scaleFactor: number) => { width: number; height: number };
              };
          }) => void)
        | null,
    reset() {
        this.callback = null;
    },
}));

const resizeObserverMock = vi.hoisted(() => ({
    callback: null as ResizeObserverCallback | null,
    reset() {
        this.callback = null;
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => currentWindowMock,
}));

vi.mock('@services/NativeService', () => ({
    native: nativeMock,
}));

vi.mock('@services/PerformanceTraceService', () => ({
    markPerformanceTrace: vi.fn(),
}));

class ResizeObserverMock {
    constructor(callback: ResizeObserverCallback) {
        resizeObserverMock.callback = callback;
    }

    observe() {}

    disconnect() {}
}

function createDeferredVoid() {
    let resolve!: () => void;
    const promise = new Promise<void>((nextResolve) => {
        resolve = nextResolve;
    });

    return {
        promise,
        resolve,
    };
}

function createWindowState(
    overrides: Partial<{
        defaults: { width: number; height: number };
        currentWidth: number;
        currentHeight: number;
        heightMode: SearchWindowHeightMode;
    }> = {}
) {
    return {
        defaults: { width: 750, height: 60 },
        currentWidth: 750,
        currentHeight: 60,
        heightMode: SearchWindowHeightMode.Auto,
        ...overrides,
    };
}

function createMeasuredElement(height: number) {
    const element = document.createElement('div');
    let measuredHeight = height;

    Object.defineProperty(element, 'clientHeight', {
        configurable: true,
        get: () => measuredHeight,
    });
    Object.defineProperty(element, 'scrollHeight', {
        configurable: true,
        get: () => measuredHeight,
    });
    Object.defineProperty(element, 'offsetHeight', {
        configurable: true,
        get: () => measuredHeight,
    });

    element.getBoundingClientRect = () =>
        ({
            width: 600,
            height: measuredHeight,
            top: 0,
            left: 0,
            right: 600,
            bottom: measuredHeight,
            x: 0,
            y: 0,
            toJSON: () => undefined,
        }) as DOMRect;

    return {
        element,
        setHeight(value: number) {
            measuredHeight = value;
        },
    };
}

function emitObservedHeight(element: Element, height: number) {
    const rect = {
        width: 600,
        height,
        top: 0,
        left: 0,
        right: 600,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => undefined,
    } as DOMRectReadOnly;
    const size = [{ blockSize: height, inlineSize: 600 }] as ResizeObserverSize[];

    resizeObserverMock.callback?.(
        [
            {
                target: element,
                borderBoxSize: size,
                contentBoxSize: size,
                contentRect: rect,
                devicePixelContentBoxSize: size,
            },
        ],
        {} as ResizeObserver
    );
}

function emitWindowResized(height: number, width = 750) {
    windowResizeListenerMock.callback?.({
        payload: {
            width,
            height,
            toLogical: (scaleFactor: number) => ({
                width: width / scaleFactor,
                height: height / scaleFactor,
            }),
        },
    });
}

async function flushResizeLifecycle() {
    await Promise.resolve();
    await nextTick();
    await Promise.resolve();
    await nextTick();
}

async function flushResizeCommit() {
    await flushResizeLifecycle();
    await Promise.resolve();
    await Promise.resolve();
}

async function waitForCallCount(
    mock: { mock: { calls: unknown[][] } },
    count: number,
    attempts = 10
) {
    for (let index = 0; index < attempts; index += 1) {
        if (mock.mock.calls.length === count) {
            return;
        }

        await Promise.resolve();
        await nextTick();
    }

    expect(mock.mock.calls.length).toBe(count);
}

describe('useSearchWindowResize', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        vi.stubGlobal('ResizeObserver', ResizeObserverMock);
        resizeObserverMock.reset();
        windowResizeListenerMock.reset();

        currentWindowMock.isVisible.mockResolvedValue(true);
        currentWindowMock.isMaximized.mockResolvedValue(false);
        currentWindowMock.maximize.mockResolvedValue(undefined);
        currentWindowMock.unmaximize.mockResolvedValue(undefined);
        currentWindowMock.scaleFactor.mockResolvedValue(1);
        currentWindowMock.onResized.mockImplementation(async (callback) => {
            windowResizeListenerMock.callback = callback;
            return () => undefined;
        });

        nativeMock.window.getSearchWindowState.mockResolvedValue(createWindowState());
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

    it('applies idle defaults and locks the min-height constraint to the configured idle height once ready', async () => {
        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref<HTMLElement | null>(null),
                sessionCount: ref(0),
                quickSearchOpen: ref(false),
                conversationPending: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready: ref(true),
            })
        );

        await flushResizeLifecycle();

        expect(nativeMock.window.setSearchWindowDefaults).toHaveBeenCalledWith({
            width: 750,
            height: 60,
        });
        expect(nativeMock.window.resetSearchWindowBounds).toHaveBeenCalledTimes(1);
        expect(nativeMock.window.setSearchWindowAllowHeightOverride).toHaveBeenCalledWith(false);
        expect(nativeMock.window.setSearchWindowMinSize).toHaveBeenLastCalledWith({
            minWidth: 750,
            minHeight: 60,
            maxHeight: 60,
        });

        mounted.unmount();
    });

    it('remeasures a managed panel and sends the measured height through the native resize contract', async () => {
        const target = createMeasuredElement(180);
        const ready = ref(false);
        const sessionCount = ref(1);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount,
                quickSearchOpen: ref(false),
                conversationPending: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        vi.clearAllMocks();

        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith({
            targetHeight: 184,
            center: true,
            animate: true,
            respectManualOverride: true,
        });
        expect(nativeMock.window.setSearchWindowMinSize).toHaveBeenLastCalledWith({
            minWidth: 750,
            minHeight: 184,
            maxHeight: null,
        });

        mounted.unmount();
    });

    it('repairs the search window back to idle defaults when a manual-override conversation view returns to idle', async () => {
        nativeMock.window.getSearchWindowState.mockResolvedValue(
            createWindowState({
                currentHeight: 240,
                heightMode: SearchWindowHeightMode.ManualOverride,
            })
        );

        const sessionCount = ref(1);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref<HTMLElement | null>(null),
                sessionCount,
                quickSearchOpen: ref(false),
                conversationPending: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready: ref(true),
            })
        );

        await flushResizeLifecycle();
        vi.clearAllMocks();

        sessionCount.value = 0;
        await flushResizeLifecycle();

        expect(nativeMock.window.resetSearchWindowBounds).toHaveBeenCalledTimes(1);
        expect(nativeMock.window.setSearchWindowAllowHeightOverride).toHaveBeenCalledWith(false);
        expect(nativeMock.window.setSearchWindowMinSize).toHaveBeenLastCalledWith({
            minWidth: 750,
            minHeight: 60,
            maxHeight: 60,
        });

        mounted.unmount();
    });

    it('allows the same measured height to resize again after an idle reset clears the previous resize target', async () => {
        const target = createMeasuredElement(180);
        const ready = ref(false);
        const sessionCount = ref(1);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount,
                quickSearchOpen: ref(false),
                conversationPending: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith({
            targetHeight: 184,
            center: true,
            animate: true,
            respectManualOverride: true,
        });

        vi.clearAllMocks();
        sessionCount.value = 0;
        await flushResizeLifecycle();

        expect(nativeMock.window.resetSearchWindowBounds).toHaveBeenCalledTimes(1);

        vi.clearAllMocks();
        sessionCount.value = 1;
        await flushResizeLifecycle();
        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith({
            targetHeight: 184,
            center: true,
            animate: true,
            respectManualOverride: true,
        });

        mounted.unmount();
    });

    it('coalesces observed height storms to the latest native resize target', async () => {
        const firstResize = createDeferredVoid();

        const target = createMeasuredElement(180);
        const ready = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                conversationPending: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        vi.clearAllMocks();
        nativeMock.window.resizeWindowHeight.mockImplementationOnce(() => firstResize.promise);

        target.setHeight(180);
        await mounted.result.remeasureTargetHeight();
        await flushResizeLifecycle();
        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledTimes(1);
        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith({
            targetHeight: 184,
            center: true,
            animate: true,
            respectManualOverride: true,
        });

        target.setHeight(220);
        emitObservedHeight(target.element, 220);
        target.setHeight(260);
        emitObservedHeight(target.element, 260);

        await flushResizeCommit();
        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledTimes(1);

        firstResize.resolve();
        await flushResizeCommit();

        await waitForCallCount(nativeMock.window.resizeWindowHeight, 2);
        expect(nativeMock.window.resizeWindowHeight).toHaveBeenLastCalledWith({
            targetHeight: 264,
            center: true,
            animate: true,
            respectManualOverride: true,
        });

        mounted.unmount();
    });

    it('adds a small overshoot when growing height but not when shrinking', async () => {
        const target = createMeasuredElement(180);
        const ready = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                conversationPending: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        vi.clearAllMocks();

        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenNthCalledWith(1, {
            targetHeight: 184,
            center: true,
            animate: true,
            respectManualOverride: true,
        });

        target.setHeight(120);
        emitObservedHeight(target.element, 120);
        await flushResizeCommit();

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenNthCalledWith(2, {
            targetHeight: 120,
            center: true,
            animate: true,
            respectManualOverride: true,
        });

        mounted.unmount();
    });

    it('does not pre-lock the visible viewport to the stale height before the first native resize event arrives', async () => {
        const resize = createDeferredVoid();
        const target = createMeasuredElement(120);
        const ready = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                conversationPending: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();
        vi.clearAllMocks();

        nativeMock.window.resizeWindowHeight.mockImplementationOnce(() => resize.promise);

        target.setHeight(180);
        emitObservedHeight(target.element, 180);
        await flushResizeLifecycle();

        expect(mounted.result.visibleViewportHeightLock.value).toBeNull();

        emitWindowResized(140);
        await flushResizeLifecycle();

        expect(mounted.result.visibleViewportHeightLock.value).toBe(140);

        resize.resolve();
        await flushResizeCommit();

        expect(mounted.result.visibleViewportHeightLock.value).toBeNull();

        mounted.unmount();
    });

    it('updates the visible viewport lock only from real window resize events while a growth animation is in flight', async () => {
        const resize = createDeferredVoid();
        const target = createMeasuredElement(120);
        const ready = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                conversationPending: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();
        vi.clearAllMocks();

        nativeMock.window.resizeWindowHeight.mockImplementationOnce(() => resize.promise);

        target.setHeight(180);
        emitObservedHeight(target.element, 180);
        await flushResizeLifecycle();

        expect(mounted.result.visibleViewportHeightLock.value).toBeNull();

        emitWindowResized(140);
        await flushResizeLifecycle();
        expect(mounted.result.visibleViewportHeightLock.value).toBe(140);

        emitWindowResized(184);
        await flushResizeLifecycle();
        expect(mounted.result.visibleViewportHeightLock.value).toBe(184);

        resize.resolve();
        await flushResizeCommit();

        expect(mounted.result.visibleViewportHeightLock.value).toBeNull();

        mounted.unmount();
    });

    it('does not lock the viewport during quick-search growth, so the panel is not clipped to shortcut-only rows', async () => {
        const resize = createDeferredVoid();
        const target = createMeasuredElement(120);
        const ready = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount: ref(0),
                quickSearchOpen: ref(true),
                conversationPending: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();
        vi.clearAllMocks();

        nativeMock.window.resizeWindowHeight.mockImplementationOnce(() => resize.promise);

        target.setHeight(180);
        emitObservedHeight(target.element, 180);
        await flushResizeLifecycle();

        emitWindowResized(140);
        await flushResizeLifecycle();

        expect(mounted.result.visibleViewportHeightLock.value).toBeNull();

        resize.resolve();
        await flushResizeCommit();

        expect(mounted.result.visibleViewportHeightLock.value).toBeNull();

        mounted.unmount();
    });

    it('ignores stale lower observed heights while a growth resize is still in flight', async () => {
        const resize = createDeferredVoid();
        const target = createMeasuredElement(120);
        const ready = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                conversationPending: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();
        vi.clearAllMocks();

        nativeMock.window.resizeWindowHeight.mockImplementationOnce(() => resize.promise);

        target.setHeight(180);
        emitObservedHeight(target.element, 180);
        await flushResizeLifecycle();

        target.setHeight(124);
        emitObservedHeight(target.element, 124);
        await flushResizeLifecycle();

        resize.resolve();
        await flushResizeCommit();

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledTimes(1);
        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith({
            targetHeight: 184,
            center: true,
            animate: true,
            respectManualOverride: true,
        });

        mounted.unmount();
    });

    it('does not re-enter a new growth lock from its own follow-up observer echo after a committed resize', async () => {
        const target = createMeasuredElement(120);
        const ready = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                conversationPending: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();
        vi.clearAllMocks();

        target.setHeight(180);
        emitObservedHeight(target.element, 180);
        await flushResizeCommit();

        expect(mounted.result.visibleViewportHeightLock.value).toBeNull();
        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledTimes(1);

        emitObservedHeight(target.element, 180);
        await flushResizeCommit();

        expect(mounted.result.visibleViewportHeightLock.value).toBeNull();
        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });

    it('does not reset back to idle defaults while the first conversation turn is still pending', async () => {
        const target = createMeasuredElement(180);
        const ready = ref(false);
        const quickSearchOpen = ref(true);
        const sessionCount = ref(0);
        const conversationPending = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount,
                quickSearchOpen,
                conversationPending,
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();
        vi.clearAllMocks();

        quickSearchOpen.value = false;
        conversationPending.value = true;
        await flushResizeLifecycle();

        expect(nativeMock.window.resetSearchWindowBounds).not.toHaveBeenCalled();
        expect(nativeMock.window.resizeWindowHeight).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('ignores transient shrink observations while switching from quick search to a pending conversation surface', async () => {
        const target = createMeasuredElement(180);
        const ready = ref(false);
        const quickSearchOpen = ref(true);
        const sessionCount = ref(0);
        const conversationPending = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount,
                quickSearchOpen,
                conversationPending,
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();
        vi.clearAllMocks();

        quickSearchOpen.value = false;
        conversationPending.value = true;
        await flushResizeLifecycle();

        target.setHeight(132);
        emitObservedHeight(target.element, 132);
        await flushResizeCommit();

        target.setHeight(96);
        emitObservedHeight(target.element, 96);
        await flushResizeCommit();

        expect(nativeMock.window.resizeWindowHeight).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('continues ignoring shrink observations after the first session message attaches while the quick-search handoff is still pending', async () => {
        const target = createMeasuredElement(180);
        const ready = ref(false);
        const quickSearchOpen = ref(true);
        const sessionCount = ref(0);
        const conversationPending = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount,
                quickSearchOpen,
                conversationPending,
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();
        vi.clearAllMocks();

        quickSearchOpen.value = false;
        conversationPending.value = true;
        sessionCount.value = 1;
        await flushResizeLifecycle();

        target.setHeight(132);
        emitObservedHeight(target.element, 132);
        await flushResizeCommit();

        expect(nativeMock.window.resizeWindowHeight).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('does not queue follow-up resizes from observer heights emitted during an animated shrink transaction', async () => {
        const resize = createDeferredVoid();
        const target = createMeasuredElement(180);
        const ready = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                conversationPending: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();
        vi.clearAllMocks();

        nativeMock.window.resizeWindowHeight.mockImplementationOnce(() => resize.promise);

        target.setHeight(120);
        emitObservedHeight(target.element, 120);
        await flushResizeLifecycle();

        target.setHeight(150);
        emitObservedHeight(target.element, 150);
        await flushResizeLifecycle();

        target.setHeight(136);
        emitObservedHeight(target.element, 136);
        await flushResizeLifecycle();

        resize.resolve();
        await flushResizeCommit();

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledTimes(1);
        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith({
            targetHeight: 120,
            center: true,
            animate: true,
            respectManualOverride: true,
        });

        mounted.unmount();
    });

    it('does not adopt the native target height mid-animation and then bounce back toward intermediate observer heights', async () => {
        const resize = createDeferredVoid();
        const target = createMeasuredElement(180);
        const ready = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                conversationPending: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();
        vi.clearAllMocks();

        nativeMock.window.resizeWindowHeight.mockImplementationOnce(() => resize.promise);

        target.setHeight(120);
        emitObservedHeight(target.element, 120);
        await flushResizeLifecycle();

        nativeMock.window.getSearchWindowState.mockResolvedValue(
            createWindowState({
                currentHeight: 120,
                heightMode: SearchWindowHeightMode.Auto,
            })
        );

        await mounted.result.syncWindowState();

        resize.resolve();
        await flushResizeCommit();

        target.setHeight(150);
        emitObservedHeight(target.element, 150);
        await flushResizeCommit();

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledTimes(1);
        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith({
            targetHeight: 120,
            center: true,
            animate: true,
            respectManualOverride: true,
        });

        mounted.unmount();
    });

    it('ignores shrink observations while a conversation is still streaming, then settles once loading ends', async () => {
        const target = createMeasuredElement(220);
        const ready = ref(false);
        const conversationPending = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                conversationPending,
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        await mounted.result.remeasureTargetHeight();
        await flushResizeCommit();
        vi.clearAllMocks();

        conversationPending.value = true;
        await flushResizeLifecycle();

        target.setHeight(180);
        emitObservedHeight(target.element, 180);
        await flushResizeCommit();

        expect(nativeMock.window.resizeWindowHeight).not.toHaveBeenCalled();

        conversationPending.value = false;
        await flushResizeCommit();

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledTimes(1);
        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith({
            targetHeight: 180,
            center: true,
            animate: true,
            respectManualOverride: true,
        });

        mounted.unmount();
    });
});
