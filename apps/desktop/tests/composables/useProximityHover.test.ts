import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { useProximityHover } from '@/views/SearchView/components/AskUser/composables/useProximityHover';

/**
 * Rows are positioned in a 200px tall list, 40px each, so row 0 covers 0-40,
 * row 1 covers 40-80 and row 2 covers 80-120. The container itself sits at y=0.
 */
const ROW_HEIGHT = 40;
const CONTAINER_HEIGHT = 200;

function createContainer() {
    const container = document.createElement('div');
    container.getBoundingClientRect = () => ({
        top: 0,
        bottom: CONTAINER_HEIGHT,
        left: 0,
        right: 400,
        width: 400,
        height: CONTAINER_HEIGHT,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    });
    Object.defineProperty(container, 'offsetHeight', {
        configurable: true,
        value: CONTAINER_HEIGHT,
    });
    Object.defineProperty(container, 'offsetWidth', { configurable: true, value: 400 });
    Object.defineProperty(container, 'clientTop', { configurable: true, value: 0 });
    Object.defineProperty(container, 'clientLeft', { configurable: true, value: 0 });
    container.scrollTop = 0;
    container.scrollLeft = 0;
    document.body.appendChild(container);
    return container;
}

function createRow(top: number, left = 0, width = 400) {
    const row = document.createElement('div');
    Object.defineProperty(row, 'offsetTop', { configurable: true, value: top });
    Object.defineProperty(row, 'offsetHeight', { configurable: true, value: ROW_HEIGHT });
    Object.defineProperty(row, 'offsetLeft', { configurable: true, value: left });
    Object.defineProperty(row, 'offsetWidth', { configurable: true, value: width });
    return row;
}

function mouseMove(clientY: number, clientX = 200) {
    return new MouseEvent('mousemove', { clientX, clientY });
}

describe('when the pointer moves over a list of options', () => {
    let rafCallbacks: FrameRequestCallback[];
    let container: HTMLDivElement;

    beforeEach(() => {
        rafCallbacks = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            rafCallbacks.push(callback);
            return rafCallbacks.length;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        container = createContainer();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    function runFrames() {
        const pending = rafCallbacks;
        rafCallbacks = [];
        for (const callback of pending) {
            callback(0);
        }
    }

    async function mountHover(axis?: 'x' | 'y') {
        const containerRef = ref<HTMLElement | null>(null);
        const mounted = await mountComposable(() => useProximityHover(containerRef, { axis }));

        containerRef.value = container;
        await nextTick();
        runFrames();

        // On the vertical axis rows stack top to bottom; on the horizontal axis
        // they sit side by side, which is what the option row layout does.
        if (axis === 'x') {
            mounted.result.registerItem(0, createRow(0, 0, 100));
            mounted.result.registerItem(1, createRow(0, 100, 100));
            mounted.result.registerItem(2, createRow(0, 200, 100));
        } else {
            mounted.result.registerItem(0, createRow(0));
            mounted.result.registerItem(1, createRow(ROW_HEIGHT));
            mounted.result.registerItem(2, createRow(ROW_HEIGHT * 2));
        }
        runFrames();

        return mounted;
    }

    it('user sees the row under the pointer highlighted', async () => {
        const { result, unmount } = await mountHover();

        result.handlers.onMouseMove(mouseMove(60));
        runFrames();

        expect(result.activeIndex.value).toBe(1);

        unmount();
    });

    it('user sees the nearest row highlighted when the pointer sits between two rows', async () => {
        const { result, unmount } = await mountHover();

        // y=78 is inside row 1, but y=84 is closest to the centre of row 2 (100).
        result.handlers.onMouseMove(mouseMove(84));
        runFrames();

        expect(result.activeIndex.value).toBe(2);

        unmount();
    });

    it('user sees the highlight cleared when the pointer leaves the list', async () => {
        const { result, unmount } = await mountHover();

        result.handlers.onMouseMove(mouseMove(60));
        runFrames();
        expect(result.activeIndex.value).toBe(1);

        result.handlers.onMouseLeave();

        expect(result.activeIndex.value).toBeNull();

        unmount();
    });

    it('user sees a new hover session so the indicator can re-animate from the new row', async () => {
        const { result, unmount } = await mountHover();
        const initialSession = result.sessionRef.value;

        result.handlers.onMouseEnter();

        expect(result.sessionRef.value).toBe(initialSession + 1);

        unmount();
    });

    it('user gets the measured row boxes exposed for the highlight overlay', async () => {
        const { result, unmount } = await mountHover();

        expect(result.itemRects.value[0]).toEqual({
            top: 0,
            height: ROW_HEIGHT,
            left: 0,
            width: 400,
        });
        expect(result.itemRects.value[2]).toEqual({
            top: ROW_HEIGHT * 2,
            height: ROW_HEIGHT,
            left: 0,
            width: 400,
        });

        unmount();
    });

    it('user gets the hover following the pointer vertically only on the default axis', async () => {
        const { result, unmount } = await mountHover();

        // Moving sideways inside row 1 must keep row 1 active.
        result.handlers.onMouseMove(mouseMove(60, 10));
        runFrames();
        expect(result.activeIndex.value).toBe(1);

        result.handlers.onMouseMove(mouseMove(60, 380));
        runFrames();
        expect(result.activeIndex.value).toBe(1);

        unmount();
    });

    it('user gets the hover following the pointer horizontally on the horizontal axis', async () => {
        const { result, unmount } = await mountHover('x');

        // Rows sit side by side on this axis, so a vertical move must not change the highlight.
        result.handlers.onMouseMove(mouseMove(200, 20));
        runFrames();
        expect(result.activeIndex.value).toBe(0);

        result.handlers.onMouseMove(mouseMove(200, 150));
        runFrames();
        expect(result.activeIndex.value).toBe(1);

        unmount();
    });

    it('user can set the highlight from code, for example when the keyboard moves it', async () => {
        const { result, unmount } = await mountHover();

        result.setActiveIndex(2);
        expect(result.activeIndex.value).toBe(2);

        result.setActiveIndex((previous) => (previous === 2 ? null : previous));
        expect(result.activeIndex.value).toBeNull();

        unmount();
    });

    it('user sees the highlight follow the row when its position changes after a remeasure', async () => {
        const { result, unmount } = await mountHover();

        const movedRow = createRow(ROW_HEIGHT * 3);
        result.registerItem(1, movedRow);
        runFrames();

        expect(result.itemRects.value[1]?.top).toBe(ROW_HEIGHT * 3);

        unmount();
    });

    it('user gets no stale row box kept after a row disappears', async () => {
        const { result, unmount } = await mountHover();

        result.registerItem(2, null);
        runFrames();

        expect(result.itemRects.value[2]).toBeUndefined();

        unmount();
    });
});

describe('when the list is unmounted while the pointer is still moving', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('user gets the pending work cancelled instead of touching a removed list', async () => {
        const container = createContainer();
        const containerRef = ref<HTMLElement | null>(null);
        const mounted = await mountComposable(() => useProximityHover(containerRef));
        containerRef.value = container;
        await nextTick();

        mounted.result.handlers.onMouseMove(mouseMove(10));
        mounted.unmount();

        expect(cancelAnimationFrame).toBeDefined();
    });
});
