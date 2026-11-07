import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageScroller, type MessageScrollerHandle } from '@/components/ui/message-scroller';

const items = [
    { id: 'm1', label: 'First', role: 'user' },
    { id: 'a1', label: 'Answer', role: 'assistant' },
];

let animationFrames: FrameRequestCallback[] = [];

function flushFrames(): void {
    const frames = [...animationFrames];
    animationFrames = [];
    for (const frame of frames) {
        frame(0);
    }
}

const wrappers: Array<{ unmount: () => void }> = [];

function mountScroller() {
    const wrapper = mount(MessageScroller, {
        attachTo: document.body,
        props: {
            items,
            label: 'Conversation',
            navigationLabel: 'Navigation',
            emptyLabel: 'Message',
            followOutput: true,
            smooth: false,
        },
        slots: { default: '<div data-message-scroller-item="m1">hello</div>' },
    });
    wrappers.push(wrapper);
    return wrapper;
}

function viewportOf(wrapper: { get: (selector: string) => { element: unknown } }): HTMLElement {
    return wrapper.get('section').element as HTMLElement;
}

function setMetrics(element: HTMLElement, scrollTop: number, scrollHeight: number): void {
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 400 });
    element.scrollTop = scrollTop;
}

describe('when the scroll position changes', () => {
    beforeEach(() => {
        animationFrames = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        });
        vi.stubGlobal('cancelAnimationFrame', () => undefined);
    });

    afterEach(() => {
        while (wrappers.length > 0) {
            wrappers.pop()?.unmount();
        }
        vi.unstubAllGlobals();
    });

    it('user keeps following when only the content got taller', async () => {
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setMetrics(viewport, 600, 1_000);
        await flushPromises();
        flushFrames();

        // 流式输出：高度变大，scrollTop 不动。
        setMetrics(viewport, 600, 1_400);
        viewport.dispatchEvent(new Event('scroll'));
        await flushPromises();
        flushFrames();

        expect(wrapper.emitted('followChange') ?? []).not.toContainEqual([false]);
    });

    it('user keeps their place when a jump settles while the content grows', async () => {
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setMetrics(viewport, 600, 1_000);
        Object.defineProperty(viewport, 'scrollTo', {
            configurable: true,
            value: ({ top }: { top: number }) => {
                viewport.scrollTop = top;
            },
        });
        await flushPromises();
        flushFrames();

        const scroller = wrapper.vm as unknown as MessageScrollerHandle;
        scroller.scrollToEnd('auto');
        await new Promise((resolve) => setTimeout(resolve, 0));

        // 程序性滚动收尾时内容又变高：不能因此把跟随关掉。
        setMetrics(viewport, 1_000, 1_400);
        viewport.dispatchEvent(new Event('scroll'));
        await flushPromises();
        flushFrames();

        expect(wrapper.emitted('followChange') ?? []).not.toContainEqual([false]);
    });
});
