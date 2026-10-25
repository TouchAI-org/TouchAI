import { mountComposable } from '@tests/utils/composables';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ref } from 'vue';

import { useWindowResize } from '@/composables/useWindowResize';

/**
 * The search window grows and shrinks with its content. Every measurement turns into a native
 * resize request, so a mistake here makes the window jump, refuse to shrink, or resize while it
 * is hidden.
 */
const { resizeWindowHeightMock, windowMock } = vi.hoisted(() => ({
    resizeWindowHeightMock: vi.fn(() => Promise.resolve()),
    windowMock: {
        label: 'main',
        isVisible: vi.fn(() => Promise.resolve(true)),
    },
}));

vi.mock('@services/NativeService', () => ({
    native: {
        window: {
            resizeWindowHeight: resizeWindowHeightMock,
        },
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => windowMock,
}));

type ResizeObserverCallback = (entries: ResizeObserverEntry[]) => void;

function resizeEntry(target: Element, blockSize: number): ResizeObserverEntry {
    return {
        target,
        contentRect: { width: 0, height: blockSize } as DOMRectReadOnly,
        borderBoxSize: [{ blockSize, inlineSize: 0 }],
        contentBoxSize: [{ blockSize, inlineSize: 0 }],
        devicePixelContentBoxSize: [{ blockSize, inlineSize: 0 }],
    };
}

let observerCallback: ResizeObserverCallback | null;
let disconnectMock: Mock;

beforeEach(() => {
    vi.clearAllMocks();
    observerCallback = null;
    disconnectMock = vi.fn<() => void>();
    windowMock.label = 'main';
    windowMock.isVisible.mockResolvedValue(true);

    globalThis.ResizeObserver = class {
        constructor(callback: ResizeObserverCallback) {
            observerCallback = callback;
        }
        observe() {
            // The real observer fires once after observe(); the test drives it explicitly.
        }
        disconnect() {
            disconnectMock();
        }
        unobserve() {
            // Not used by the composable.
        }
    } as unknown as typeof ResizeObserver;
});

function elementWithHeight(clientHeight: number, scrollHeight: number) {
    const element = document.createElement('div');
    Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true });
    Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true });
    return element;
}

describe('user watches the search window follow its content', () => {
    it('user gets the window resized to the measured content height', async () => {
        const target = ref<HTMLElement | null>(null);
        const { unmount } = await mountComposable(() => useWindowResize({ target }));
        target.value = elementWithHeight(120, 180);
        await Promise.resolve();
        await Promise.resolve();

        observerCallback?.([resizeEntry(target.value as Element, 180)]);
        await Promise.resolve();
        await Promise.resolve();

        // scrollHeight wins over clientHeight so scrolled-out content is not clipped.
        expect(resizeWindowHeightMock).toHaveBeenCalledWith(
            expect.objectContaining({ targetHeight: 180 })
        );
        unmount();
    });

    it('user gets the height clamped to the configured maximum', async () => {
        const target = ref<HTMLElement | null>(null);
        const { unmount } = await mountComposable(() =>
            useWindowResize({ target, maxHeight: 300 })
        );
        target.value = elementWithHeight(500, 500);
        await Promise.resolve();
        await Promise.resolve();

        observerCallback?.([resizeEntry(target.value as Element, 500)]);
        await Promise.resolve();
        await Promise.resolve();

        expect(resizeWindowHeightMock).toHaveBeenCalledWith(
            expect.objectContaining({ targetHeight: 300 })
        );
        unmount();
    });

    it('user gets the height clamped up to the configured minimum', async () => {
        const target = ref<HTMLElement | null>(null);
        const { unmount } = await mountComposable(() => useWindowResize({ target, minHeight: 60 }));
        target.value = elementWithHeight(10, 10);
        await Promise.resolve();
        await Promise.resolve();

        observerCallback?.([resizeEntry(target.value as Element, 10)]);
        await Promise.resolve();
        await Promise.resolve();

        expect(resizeWindowHeightMock).toHaveBeenCalledWith(
            expect.objectContaining({ targetHeight: 60 })
        );
        unmount();
    });

    it('user does not get a second resize for the same height', async () => {
        const target = ref<HTMLElement | null>(null);
        const { unmount } = await mountComposable(() => useWindowResize({ target }));
        target.value = elementWithHeight(200, 200);
        await Promise.resolve();
        await Promise.resolve();

        observerCallback?.([resizeEntry(target.value as Element, 200)]);
        await Promise.resolve();
        await Promise.resolve();
        observerCallback?.([resizeEntry(target.value as Element, 200)]);
        await Promise.resolve();
        await Promise.resolve();

        // Re-requesting the same height would make the window flicker.
        expect(resizeWindowHeightMock).toHaveBeenCalledTimes(1);
        unmount();
    });

    it('user gets the measured height remembered', async () => {
        const target = ref<HTMLElement | null>(null);
        const { result, unmount } = await mountComposable(() => useWindowResize({ target }));
        target.value = elementWithHeight(200, 200);
        await Promise.resolve();
        await Promise.resolve();

        observerCallback?.([resizeEntry(target.value as Element, 200)]);
        await Promise.resolve();
        await Promise.resolve();

        expect(result.currentHeight.value).toBe(200);
        unmount();
    });

    it('user gets the height forgotten when the measurement is reset', async () => {
        const target = ref<HTMLElement | null>(null);
        const { result, unmount } = await mountComposable(() => useWindowResize({ target }));
        target.value = elementWithHeight(200, 200);
        await Promise.resolve();
        await Promise.resolve();
        observerCallback?.([resizeEntry(target.value as Element, 200)]);
        await Promise.resolve();
        await Promise.resolve();

        result.resetMeasuredHeight();

        expect(result.currentHeight.value).toBe(0);
        unmount();
    });

    it('user gets a resize forced even when the height did not change', async () => {
        const target = ref<HTMLElement | null>(null);
        const { result, unmount } = await mountComposable(() => useWindowResize({ target }));
        target.value = elementWithHeight(200, 200);
        await Promise.resolve();
        await Promise.resolve();
        observerCallback?.([resizeEntry(target.value as Element, 200)]);
        await Promise.resolve();
        await Promise.resolve();

        await result.requestResize();

        // The explicit request exists precisely to re-apply the current height.
        expect(resizeWindowHeightMock).toHaveBeenCalledTimes(2);
        unmount();
    });

    it('user does not get a hidden secondary window resized', async () => {
        windowMock.label = 'settings';
        windowMock.isVisible.mockResolvedValue(false);
        const target = ref<HTMLElement | null>(null);
        const { unmount } = await mountComposable(() => useWindowResize({ target }));
        target.value = elementWithHeight(200, 200);
        await Promise.resolve();
        await Promise.resolve();

        observerCallback?.([resizeEntry(target.value as Element, 200)]);
        await Promise.resolve();
        await Promise.resolve();

        // Resizing a hidden window would move it behind the user's back.
        expect(resizeWindowHeightMock).not.toHaveBeenCalled();
        unmount();
    });

    it('user gets the observer disconnected when the target goes away', async () => {
        const target = ref<HTMLElement | null>(null);
        const { unmount } = await mountComposable(() => useWindowResize({ target }));
        target.value = elementWithHeight(200, 200);
        await Promise.resolve();
        await Promise.resolve();

        target.value = null;
        await Promise.resolve();
        await Promise.resolve();

        expect(disconnectMock).toHaveBeenCalled();
        unmount();
    });

    it('user gets the observer disconnected when the view unmounts', async () => {
        const target = ref<HTMLElement | null>(null);
        const { unmount } = await mountComposable(() => useWindowResize({ target }));
        target.value = elementWithHeight(200, 200);
        await Promise.resolve();
        await Promise.resolve();

        unmount();

        expect(disconnectMock).toHaveBeenCalled();
    });
});
