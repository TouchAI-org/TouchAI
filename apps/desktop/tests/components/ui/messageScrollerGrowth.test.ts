import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageScroller, type MessageScrollerItem } from '@/components/ui/message-scroller';

const items: MessageScrollerItem[] = [
    { id: 'm1', label: 'First question', role: 'user' },
    { id: 'a1', label: 'First answer', role: 'assistant' },
];

let animationFrames: FrameRequestCallback[] = [];
let resizeCallbacks: ResizeObserverCallback[] = [];

function triggerResize(): void {
    for (const callback of resizeCallbacks) {
        callback([], {} as ResizeObserver);
    }
}

function viewportOf(wrapper: { get: (selector: string) => { element: unknown } }): HTMLElement {
    return wrapper.get('section').element as HTMLElement;
}

function setScrollHeight(element: HTMLElement, height: number): void {
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: height });
}

function stubScrollTo(element: HTMLElement) {
    const scrollTo = vi.fn(({ top }: { top: number }) => {
        element.scrollTop = top;
    });
    Object.defineProperty(element, 'scrollTo', { configurable: true, value: scrollTo });
    return scrollTo;
}

async function settleLayout(): Promise<void> {
    const frames = [...animationFrames];
    animationFrames = [];
    for (const frame of frames) {
        frame(0);
    }
    await flushPromises();
}

const wrappers: Array<{ unmount: () => void }> = [];

function mountScroller() {
    const wrapper = mount(MessageScroller, {
        attachTo: document.body,
        props: {
            items,
            label: 'Conversation',
            navigationLabel: 'Message navigation',
            emptyLabel: 'Message',
            followOutput: true,
            smooth: false,
        },
        slots: { default: '<div data-message-scroller-item="m1">hello</div>' },
    });
    wrappers.push(wrapper);
    return wrapper;
}

describe('when streamed output grows while the user is reading the live edge', () => {
    beforeEach(() => {
        animationFrames = [];
        resizeCallbacks = [];
        vi.stubGlobal(
            'ResizeObserver',
            class {
                constructor(callback: ResizeObserverCallback) {
                    resizeCallbacks.push(callback);
                }

                observe(): void {}

                unobserve(): void {}

                disconnect(): void {}
            }
        );
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

    it('user keeps following when the content gets taller without any scroll', async () => {
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setScrollHeight(viewport, 1_000);
        Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
        viewport.scrollTop = 600;
        const scrollTo = stubScrollTo(viewport);
        await settleLayout();
        scrollTo.mockClear();

        // The answer streams in: the content grows, and the browser reports both a
        // resize and a scroll event even though the user never moved anything.
        setScrollHeight(viewport, 1_200);
        triggerResize();
        viewport.dispatchEvent(new Event('scroll'));
        await settleLayout();

        expect(scrollTo).toHaveBeenCalled();
        expect(viewport.scrollTop).toBe(800);
        const followEvents = wrapper.emitted('followChange') ?? [];
        const lastFollowEvent = followEvents[followEvents.length - 1];
        expect(lastFollowEvent?.[0] ?? true).toBe(true);
    });
});
