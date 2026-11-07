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

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => currentWindowMock,
}));

vi.mock('@services/NativeService', () => ({
    native: nativeMock,
}));

class ResizeObserverMock {
    constructor(callback: ResizeObserverCallback) {
        void callback;
    }

    observe() {}

    disconnect() {}
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

async function flushResizeLifecycle() {
    await Promise.resolve();
    await nextTick();
    await Promise.resolve();
    await nextTick();
}

describe('when the search window has no conversation on screen', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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

    it('probes maximized and height-mode state in parallel', async () => {
        let resolveMaximized!: (value: boolean) => void;
        let resolveWindowState!: (value: ReturnType<typeof createWindowState>) => void;
        currentWindowMock.isMaximized.mockReturnValue(
            new Promise<boolean>((resolve) => {
                resolveMaximized = resolve;
            })
        );
        nativeMock.window.getSearchWindowState.mockReturnValue(
            new Promise<ReturnType<typeof createWindowState>>((resolve) => {
                resolveWindowState = resolve;
            })
        );

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref<HTMLElement | null>(null),
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready: ref(true),
            })
        );
        await Promise.resolve();
        await nextTick();

        try {
            // 两个探测互相独立：后一个不应等前一个解析后才发出。
            expect(currentWindowMock.isMaximized).toHaveBeenCalledTimes(1);
            expect(nativeMock.window.getSearchWindowState).toHaveBeenCalledTimes(1);
        } finally {
            resolveMaximized(false);
            resolveWindowState(createWindowState());
            await flushResizeLifecycle();
            mounted.unmount();
        }
    });

    it('user gets the configured default size applied once the window is ready', async () => {
        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref<HTMLElement | null>(null),
                sessionCount: ref(0),
                quickSearchOpen: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready: ref(true),
            })
        );

        await flushResizeLifecycle();

        expect(nativeMock.window.setSearchWindowDefaults).toHaveBeenCalledWith({
            width: 750,
            height: 60,
        });

        mounted.unmount();
    });

    it('user cannot make the idle window taller or shorter by dragging its edge', async () => {
        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref<HTMLElement | null>(null),
                sessionCount: ref(0),
                quickSearchOpen: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready: ref(true),
            })
        );

        await flushResizeLifecycle();

        // The idle window is pinned to the default height on both sides.
        expect(nativeMock.window.setSearchWindowMinSize).toHaveBeenLastCalledWith({
            minWidth: 750,
            minHeight: 60,
            maxHeight: 60,
        });
        expect(nativeMock.window.setSearchWindowAllowHeightOverride).toHaveBeenCalledWith(false);

        mounted.unmount();
    });

    it('user cannot maximize the search bar on its own', async () => {
        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref<HTMLElement | null>(null),
                sessionCount: ref(0),
                quickSearchOpen: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready: ref(true),
            })
        );

        await flushResizeLifecycle();
        await mounted.result.toggleMaximize();

        expect(mounted.result.effectiveWindowMaximized.value).toBe(false);

        mounted.unmount();
    });

    it('user gets the idle height restored when a conversation with a hand-picked height closes', async () => {
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
                defaultSize: ref({ width: 750, height: 60 }),
                ready: ref(true),
            })
        );

        await flushResizeLifecycle();
        vi.clearAllMocks();

        sessionCount.value = 0;
        await flushResizeLifecycle();

        expect(nativeMock.window.resetSearchWindowBounds).toHaveBeenCalled();
        expect(nativeMock.window.setSearchWindowMinSize).toHaveBeenLastCalledWith({
            minWidth: 750,
            minHeight: 60,
            maxHeight: 60,
        });

        mounted.unmount();
    });
});

describe('when a conversation is on screen', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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

    it('user gets the window following the conversation height as content grows', async () => {
        const target = createMeasuredElement(180);
        const ready = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        vi.clearAllMocks();

        // Nothing changed yet, so the window must not be resized again.
        await mounted.result.remeasureTargetHeight();
        expect(nativeMock.window.resizeWindowHeight).not.toHaveBeenCalled();

        target.setHeight(220);
        await mounted.result.remeasureTargetHeight();

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith({
            targetHeight: 220,
            center: true,
            animate: false,
            respectManualOverride: true,
        });

        mounted.unmount();
    });

    it('user gets a taller minimum height so the conversation can grow without a jump', async () => {
        const target = createMeasuredElement(180);
        const ready = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        await mounted.result.remeasureTargetHeight();

        // Once the conversation is measured, the floor follows it instead of the
        // idle height, so the window can shrink back down without being blocked.
        expect(nativeMock.window.setSearchWindowMinSize).toHaveBeenLastCalledWith({
            minWidth: 750,
            minHeight: 180,
            maxHeight: null,
        });

        mounted.unmount();
    });

    it('user keeps a hand-picked height instead of having the window follow the content', async () => {
        const target = createMeasuredElement(180);
        nativeMock.window.getSearchWindowState.mockResolvedValue(
            createWindowState({
                currentHeight: 300,
                heightMode: SearchWindowHeightMode.ManualOverride,
            })
        );

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready: ref(true),
            })
        );

        await flushResizeLifecycle();
        vi.clearAllMocks();

        target.setHeight(400);
        await mounted.result.remeasureTargetHeight();

        expect(nativeMock.window.resizeWindowHeight).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets no resize while the search window is hidden', async () => {
        currentWindowMock.isVisible.mockResolvedValue(false);
        const target = createMeasuredElement(180);
        const ready = ref(false);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref(target.element),
                sessionCount: ref(1),
                quickSearchOpen: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        vi.clearAllMocks();

        target.setHeight(400);
        await mounted.result.remeasureTargetHeight();

        expect(nativeMock.window.resizeWindowHeight).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user can maximize the conversation and restore it later, even after the conversation closes', async () => {
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
        expect(mounted.result.isMaximized.value).toBe(true);
        expect(mounted.result.effectiveWindowMaximized.value).toBe(true);

        // Closing the conversation must not trap the window in the maximized state.
        sessionCount.value = 0;
        await mounted.result.toggleMaximize();
        expect(mounted.result.effectiveWindowMaximized.value).toBe(false);

        mounted.unmount();
    });
});

describe('when the quick search panel replaces the conversation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('ResizeObserver', ResizeObserverMock);
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });

        currentWindowMock.isVisible.mockResolvedValue(true);
        currentWindowMock.isMaximized.mockResolvedValue(false);
        currentWindowMock.onResized.mockImplementation(async () => () => undefined);

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

    it('user gets the window following the panel without letting a manual height stick', async () => {
        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref<HTMLElement | null>(null),
                sessionCount: ref(0),
                quickSearchOpen: ref(true),
                defaultSize: ref({ width: 750, height: 60 }),
                ready: ref(true),
            })
        );

        await flushResizeLifecycle();

        expect(nativeMock.window.setSearchWindowAllowHeightOverride).toHaveBeenCalledWith(false);
        expect(nativeMock.window.setSearchWindowMinSize).toHaveBeenLastCalledWith(
            expect.objectContaining({ maxHeight: null })
        );

        mounted.unmount();
    });
});

describe('when the window stops being observed', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('ResizeObserver', ResizeObserverMock);
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });

        currentWindowMock.isVisible.mockResolvedValue(true);
        currentWindowMock.isMaximized.mockResolvedValue(false);
        currentWindowMock.onResized.mockResolvedValue(() => undefined);

        nativeMock.window.getSearchWindowState.mockResolvedValue(createWindowState());
        nativeMock.window.setSearchWindowDefaults.mockImplementation(async (defaults) => defaults);
        nativeMock.window.setSearchWindowMinSize.mockResolvedValue(undefined);
        nativeMock.window.setSearchWindowAllowHeightOverride.mockResolvedValue(undefined);
        nativeMock.window.resetSearchWindowBounds.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('user gets the window resize listener released when leaving the search view', async () => {
        const unlisten = vi.fn();
        currentWindowMock.onResized.mockResolvedValue(unlisten);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target: ref<HTMLElement | null>(null),
                sessionCount: ref(0),
                quickSearchOpen: ref(false),
                defaultSize: ref({ width: 750, height: 60 }),
                ready: ref(true),
            })
        );

        await flushResizeLifecycle();
        mounted.unmount();
        await flushResizeLifecycle();

        expect(unlisten).toHaveBeenCalled();
    });
});
