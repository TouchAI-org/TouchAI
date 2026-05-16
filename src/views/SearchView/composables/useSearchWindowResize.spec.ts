import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { SearchWindowHeightMode } from '@/config/searchWindow';

import { mountComposable } from '../../../../tests/utils/composables';
import { useSearchWindowResize } from './useSearchWindowResize';

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

describe('useSearchWindowResize', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        vi.stubGlobal('ResizeObserver', ResizeObserverMock);

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

    it('applies idle defaults and locks the min-height constraint to the configured idle height once ready', async () => {
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
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
            })
        );

        ready.value = true;
        await flushResizeLifecycle();
        vi.clearAllMocks();

        await mounted.result.remeasureTargetHeight();

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith({
            targetHeight: 180,
            center: true,
            respectManualOverride: true,
        });
        expect(nativeMock.window.setSearchWindowMinSize).toHaveBeenLastCalledWith({
            minWidth: 750,
            minHeight: 180,
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
});
