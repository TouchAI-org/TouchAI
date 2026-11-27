import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { useScrollbarStabilizer } from '@/composables/useScrollbarStabilizer';

type ObserverCallback = () => void;

class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    readonly callback: ObserverCallback;
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();

    constructor(callback: ObserverCallback) {
        this.callback = callback;
        FakeResizeObserver.instances.push(this);
    }
}

function scrollContainer(metrics: { scrollHeight: number; clientHeight: number }): HTMLElement {
    const element = document.createElement('div');
    Object.defineProperty(element, 'offsetWidth', { configurable: true, value: 200 });
    Object.defineProperty(element, 'clientWidth', { configurable: true, value: 184 });
    Object.defineProperty(element, 'scrollHeight', {
        configurable: true,
        get: () => metrics.scrollHeight,
    });
    Object.defineProperty(element, 'clientHeight', {
        configurable: true,
        get: () => metrics.clientHeight,
    });
    document.body.appendChild(element);
    return element;
}

let frames: FrameRequestCallback[] = [];

beforeEach(() => {
    frames = [];
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
        frames.splice(handle - 1, 1, () => undefined);
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('given the settings scroll container resizes inside a ResizeObserver delivery', () => {
    it('user gets scrollbar compensation on the next frame instead of during the delivery', async () => {
        const metrics = { scrollHeight: 400, clientHeight: 300 };
        const element = scrollContainer(metrics);
        const container = ref<HTMLElement | null>(element);
        const view = await mountComposable(() => useScrollbarStabilizer(container));
        await nextTick();

        metrics.scrollHeight = 200;
        FakeResizeObserver.instances.at(-1)?.callback();

        // 观察回调里不写布局，浏览器因此不会再排一次通知。
        expect(element.style.paddingRight).toBe('');
        expect(frames).toHaveLength(1);

        frames.shift()?.(0);
        // 滚动条宽度 200 - 184 = 16px 补偿到原来的 0 上。
        expect(element.style.paddingRight).toBe('16px');

        view.unmount();
    });

    it('user does not receive a pending compensation after the container unmounts', async () => {
        const metrics = { scrollHeight: 400, clientHeight: 300 };
        const element = scrollContainer(metrics);
        const container = ref<HTMLElement | null>(element);
        const view = await mountComposable(() => useScrollbarStabilizer(container));
        await nextTick();

        metrics.scrollHeight = 200;
        FakeResizeObserver.instances.at(-1)?.callback();
        view.unmount();
        await nextTick();

        for (const frame of frames.splice(0)) frame(0);
        expect(element.style.paddingRight).toBe('');
    });
});
