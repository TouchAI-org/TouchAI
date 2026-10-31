import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import {
    MessageScroller,
    type MessageScrollerHandle,
    type MessageScrollerItem,
} from '@/components/ui/message-scroller';

enableAutoUnmount(afterEach);

const items: MessageScrollerItem[] = [
    {
        id: 'm1',
        label: 'How should the first release work?',
        description: 'Start with the smallest complete workflow.',
        role: 'user',
    },
    {
        id: 'a1',
        label: 'Start with the smallest complete workflow.',
        role: 'assistant',
    },
    {
        id: 'm2',
        label: 'What should happen while the answer streams?',
        role: 'user',
    },
];

let resizeCallbacks: ResizeObserverCallback[] = [];
let animationFrames: FrameRequestCallback[] = [];

class ResizeObserverStub {
    constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
    }

    observe(): void {}

    unobserve(): void {}

    disconnect(): void {}
}

function flushAnimationFrames(): void {
    const callbacks = animationFrames.splice(0);
    callbacks.forEach((callback) => callback(performance.now()));
}

async function settleLayout(): Promise<void> {
    await nextTick();
    flushAnimationFrames();
    await nextTick();
    flushAnimationFrames();
    await nextTick();
    await flushPromises();
}

function triggerResize(): void {
    resizeCallbacks.forEach((callback) => {
        callback([], {} as ResizeObserver);
    });
}

function mountScroller(
    options: {
        followOutput?: boolean;
        smooth?: boolean;
        scrollerItems?: MessageScrollerItem[];
    } = {}
) {
    const scrollerItems = options.scrollerItems ?? items;
    return mount(MessageScroller, {
        attachTo: document.body,
        props: {
            items: scrollerItems,
            label: 'Conversation',
            navigationLabel: 'Message navigation',
            emptyLabel: 'Message',
            navigation: 'rail',
            followOutput: options.followOutput ?? false,
            smooth: options.smooth ?? false,
        },
        slots: {
            default: scrollerItems
                .map((item) => `<div data-message-scroller-item="${item.id}">${item.label}</div>`)
                .join(''),
        },
    });
}

function viewportOf(wrapper: VueWrapper): HTMLElement {
    return wrapper.get('section').element as HTMLElement;
}

function setScrollMetrics(
    element: HTMLElement,
    metrics: { scrollTop?: number; scrollHeight?: number; clientHeight?: number }
): void {
    setScrollHeight(element, metrics.scrollHeight ?? 1_000);
    Object.defineProperty(element, 'clientHeight', {
        configurable: true,
        value: metrics.clientHeight ?? 400,
    });
    element.scrollTop = metrics.scrollTop ?? 0;
}

function setScrollHeight(element: HTMLElement, scrollHeight: number): void {
    Object.defineProperty(element, 'scrollHeight', {
        configurable: true,
        writable: true,
        value: scrollHeight,
    });
}

function stubScrollTo(element: HTMLElement): ReturnType<typeof vi.fn> {
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
        element.scrollTop = top ?? 0;
    });
    Object.defineProperty(element, 'scrollTo', {
        configurable: true,
        value: scrollTo,
    });
    return scrollTo;
}

function stubRect(element: HTMLElement, rect: { top: number; height: number }): void {
    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            top: rect.top,
            height: rect.height,
            bottom: rect.top + rect.height,
            left: 0,
            right: 0,
            width: 0,
            x: 0,
            y: rect.top,
            toJSON: () => ({}),
        }),
    });
}

function pointerEvent(type: string, pointerType: 'mouse' | 'touch', target: HTMLElement): void {
    const event = new PointerEvent(type, {
        bubbles: type !== 'pointerenter',
        pointerType,
        buttons: type === 'pointerdown' ? 1 : 0,
    });
    target.dispatchEvent(event);
}

beforeEach(() => {
    resizeCallbacks = [];
    animationFrames = [];
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('user navigates a long conversation', () => {
    it('user sees one rail tick for every message when the transcript overflows', async () => {
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 1_200, clientHeight: 400 });

        triggerResize();
        await settleLayout();

        expect(wrapper.find('nav').attributes('aria-label')).toBe('Message navigation');
        expect(wrapper.findAll('[data-slot="message-scroller-rail-item"]')).toHaveLength(
            items.length
        );
    });

    it('user sees equal tick lengths and visible-message colouring without hovering', async () => {
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 1_200, clientHeight: 400 });
        stubRect(viewport, { top: 0, height: 400 });
        stubRect(wrapper.get('[data-message-scroller-item="m1"]').element as HTMLElement, {
            top: -60,
            height: 180,
        });
        stubRect(wrapper.get('[data-message-scroller-item="a1"]').element as HTMLElement, {
            top: 100,
            height: 180,
        });
        stubRect(wrapper.get('[data-message-scroller-item="m2"]').element as HTMLElement, {
            top: 800,
            height: 180,
        });
        triggerResize();
        await settleLayout();

        const ticks = wrapper.findAll('[data-slot="message-scroller-rail-item"]');
        const lines = wrapper.findAll('[data-slot="message-scroller-tick"]');

        expect(new Set(lines.map((line) => line.attributes('style') ?? '')).size).toBe(1);
        expect(lines.every((line) => line.classes().includes('h-0.5'))).toBe(true);
        expect(lines.every((line) => line.classes().includes('w-3'))).toBe(true);
        expect(ticks[0]!.classes()).toContain('text-primary-500');
        expect(ticks[1]!.classes()).toContain('text-primary-500');
        expect(ticks[2]!.classes()).toContain('text-scrollbar-thumb');
    });

    it('user sees no rail when every message already fits', async () => {
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 400, clientHeight: 400 });

        triggerResize();
        await settleLayout();

        expect(wrapper.find('nav').exists()).toBe(false);
    });

    it('user sees no rail for a single message', async () => {
        const wrapper = mountScroller({ scrollerItems: [items[0]!] });
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 1_200, clientHeight: 400 });

        triggerResize();
        await settleLayout();

        expect(wrapper.find('nav').exists()).toBe(false);
    });

    it('user sees a message preview when pointing at its tick', async () => {
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 1_200, clientHeight: 400 });
        triggerResize();
        await settleLayout();

        const firstTick = wrapper.findAll('[data-slot="message-scroller-rail-item"]')[0]!;
        pointerEvent('pointerenter', 'mouse', firstTick.element as HTMLElement);
        await nextTick();
        await flushPromises();

        const preview = wrapper.get('[data-slot="message-scroller-preview"]');
        expect(preview.text()).toContain('How should the first release work?');
        expect(preview.text()).toContain('Start with the smallest complete workflow.');
        expect(preview.classes()).toContain('font-serif');
        expect(preview.classes()).toContain('bg-background-primary');
        expect(preview.get('p').classes()).toContain('truncate');
        expect(
            wrapper.get('[data-slot="message-scroller-preview-description"]').classes()
        ).toContain('line-clamp-3');
    });

    it('user sees neighbouring ticks rise in a wave when pointing at a tick', async () => {
        const waveItems: MessageScrollerItem[] = Array.from({ length: 7 }, (_, index) => ({
            id: `wave-${index + 1}`,
            label: `Message ${index + 1}`,
        }));
        const wrapper = mountScroller({ scrollerItems: waveItems });
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 1_600, clientHeight: 400 });
        triggerResize();
        await settleLayout();

        const ticks = wrapper.findAll('[data-slot="message-scroller-rail-item"]');
        pointerEvent('pointerenter', 'mouse', ticks[3]!.element as HTMLElement);
        await nextTick();
        await flushPromises();

        const scales = wrapper
            .findAll('[data-slot="message-scroller-tick"]')
            .map((tick) => Number(tick.attributes('data-tick-scale')));

        expect(scales[3]).toBe(1.5);
        expect(scales[2]).toBe(1.28);
        expect(scales[4]).toBe(1.28);
        expect(scales[1]).toBe(1.12);
        expect(scales[5]).toBe(1.12);
    });

    it('user sees a long preview shortened before it covers the conversation', async () => {
        const longItems: MessageScrollerItem[] = [
            {
                id: 'long',
                label: 'A very long question that keeps going with enough words to cross the preview boundary',
                description:
                    'A very long answer that also keeps going with enough words to cross the description boundary',
            },
        ];
        const wrapper = mountScroller({
            scrollerItems: [...longItems, { id: 'short', label: 'Short follow-up' }],
        });
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 1_200, clientHeight: 400 });
        triggerResize();
        await settleLayout();

        const tick = wrapper.findAll('[data-slot="message-scroller-rail-item"]')[0]!;
        pointerEvent('pointerenter', 'mouse', tick.element as HTMLElement);
        await nextTick();
        await flushPromises();

        const preview = wrapper.get('[data-slot="message-scroller-preview"]');
        const description = wrapper.get('[data-slot="message-scroller-preview-description"]');
        expect(preview.get('p').text()).toContain('...');
        expect(description.text()).toContain('...');
    });

    it('user sees the rest of a long message when it has no separate description', async () => {
        const longItem: MessageScrollerItem = {
            id: 'long',
            label: 'A very long question that keeps going with enough words to cross the preview boundary and continue into the description',
        };
        const wrapper = mountScroller({
            scrollerItems: [longItem, { id: 'short', label: 'Short follow-up' }],
        });
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 1_200, clientHeight: 400 });
        triggerResize();
        await settleLayout();

        const tick = wrapper.findAll('[data-slot="message-scroller-rail-item"]')[0]!;
        pointerEvent('pointerenter', 'mouse', tick.element as HTMLElement);
        await nextTick();
        await flushPromises();

        const preview = wrapper.get('[data-slot="message-scroller-preview"]');
        expect(preview.get('p').text()).toContain('...');
        expect(wrapper.get('[data-slot="message-scroller-preview-description"]').text()).toContain(
            'description'
        );
    });

    it('user jumps to a message when selecting its tick', async () => {
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 1_600, clientHeight: 400 });
        const scrollTo = stubScrollTo(viewport);
        stubRect(viewport, { top: 0, height: 400 });
        const secondMessage = wrapper.get('[data-message-scroller-item="a1"]')
            .element as HTMLElement;
        stubRect(secondMessage, { top: 800, height: 100 });
        triggerResize();
        await settleLayout();

        await wrapper.findAll('[data-slot="message-scroller-rail-item"]')[1]!.trigger('click');
        await nextTick();

        expect(scrollTo).toHaveBeenCalledWith({ top: 650, behavior: 'smooth' });
    });

    it('user sees the latest message highlighted when at the live edge', async () => {
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, {
            scrollTop: 800,
            scrollHeight: 1_200,
            clientHeight: 400,
        });
        triggerResize();
        await settleLayout();

        viewport.dispatchEvent(new Event('scroll'));
        await settleLayout();

        const ticks = wrapper.findAll('[data-slot="message-scroller-rail-item"]');
        expect(ticks[ticks.length - 1]!.attributes('aria-current')).toBe('location');
    });

    it('user can use the exposed navigation controls', async () => {
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, {
            scrollTop: 100,
            scrollHeight: 1_600,
            clientHeight: 400,
        });
        const scrollTo = stubScrollTo(viewport);
        stubRect(viewport, { top: 0, height: 400 });
        stubRect(wrapper.get('[data-message-scroller-item="a1"]').element as HTMLElement, {
            top: 800,
            height: 100,
        });
        await settleLayout();

        const scroller = wrapper.vm as unknown as MessageScrollerHandle;
        expect(scroller.getState().scrollTop).toBe(100);
        expect(scroller.isAtEnd()).toBe(false);

        scroller.focus();
        expect(document.activeElement).toBe(viewport);

        scroller.scrollBy(50);
        await settleLayout();
        expect(viewport.scrollTop).toBe(150);

        scroller.recalculate();
        expect(scroller.scrollToItem('missing', { behavior: 'auto' })).toBe(false);
        expect(
            scroller.scrollToItem('a1', {
                align: 'end',
                offset: 10,
                behavior: 'auto',
            })
        ).toBe(true);
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 640, behavior: 'auto' });
    });

    it('user reaches the end by selecting the latest navigation tick', async () => {
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 1_600, clientHeight: 400 });
        const scrollTo = stubScrollTo(viewport);
        triggerResize();
        await settleLayout();

        const ticks = wrapper.findAll('[data-slot="message-scroller-rail-item"]');
        await ticks[ticks.length - 1]!.trigger('click');
        await nextTick();

        expect(scrollTo).toHaveBeenLastCalledWith({ top: 1_200, behavior: 'auto' });
    });

    it('user can dismiss a preview with touch, keyboard, or focus changes', async () => {
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 1_200, clientHeight: 400 });
        triggerResize();
        await settleLayout();

        const tick = wrapper.findAll('[data-slot="message-scroller-rail-item"]')[0]!;
        const tickElement = tick.element as HTMLElement;
        pointerEvent('pointerenter', 'mouse', tickElement);
        await nextTick();
        expect(wrapper.find('[data-slot="message-scroller-preview"]').exists()).toBe(true);

        pointerEvent('pointerleave', 'mouse', tickElement);
        await nextTick();
        expect(wrapper.find('[data-slot="message-scroller-preview"]').exists()).toBe(false);

        pointerEvent('pointerdown', 'touch', tickElement);
        await nextTick();
        expect(wrapper.find('[data-slot="message-scroller-preview"]').exists()).toBe(true);

        document.body.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })
        );
        await nextTick();
        expect(wrapper.find('[data-slot="message-scroller-preview"]').exists()).toBe(false);

        pointerEvent('pointerdown', 'touch', tickElement);
        await nextTick();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await nextTick();
        expect(wrapper.find('[data-slot="message-scroller-preview"]').exists()).toBe(false);

        Object.defineProperty(tickElement, 'matches', {
            configurable: true,
            value: (selector: string) => selector === ':focus-visible',
        });
        tickElement.dispatchEvent(new FocusEvent('focus'));
        await nextTick();
        expect(wrapper.find('[data-slot="message-scroller-preview"]').exists()).toBe(true);

        tickElement.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }));
        await nextTick();
        expect(wrapper.find('[data-slot="message-scroller-preview"]').exists()).toBe(false);
    });
});

describe('user follows streamed output', () => {
    it('user stays at the live edge while output grows', async () => {
        const wrapper = mountScroller({ followOutput: true });
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, {
            scrollTop: 600,
            scrollHeight: 1_000,
            clientHeight: 400,
        });
        const scrollTo = stubScrollTo(viewport);
        await settleLayout();
        scrollTo.mockClear();

        setScrollHeight(viewport, 1_200);
        triggerResize();
        await settleLayout();

        expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'auto' });
        expect(viewport.scrollTop).toBe(800);
    });

    it('user keeps their reading position after scrolling away', async () => {
        const wrapper = mountScroller({ followOutput: true });
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, {
            scrollTop: 600,
            scrollHeight: 1_000,
            clientHeight: 400,
        });
        const scrollTo = stubScrollTo(viewport);
        await settleLayout();

        viewport.scrollTop = 100;
        viewport.dispatchEvent(new Event('scroll'));
        await settleLayout();
        scrollTo.mockClear();

        setScrollHeight(viewport, 1_200);
        triggerResize();
        await settleLayout();

        expect(viewport.scrollTop).toBe(100);
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('user resumes following after returning to the live edge', async () => {
        const wrapper = mountScroller({ followOutput: true });
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, {
            scrollTop: 600,
            scrollHeight: 1_000,
            clientHeight: 400,
        });
        stubScrollTo(viewport);
        await settleLayout();

        viewport.scrollTop = 100;
        viewport.dispatchEvent(new Event('scroll'));
        await settleLayout();

        viewport.scrollTop = 600;
        viewport.dispatchEvent(new Event('scroll'));
        await settleLayout();

        expect(wrapper.emitted('followChange')).toContainEqual([false]);
        expect(wrapper.emitted('followChange')).toContainEqual([true]);
    });

    it('user is taken to the latest output when follow mode is enabled', async () => {
        const wrapper = mountScroller({ followOutput: false });
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, {
            scrollTop: 0,
            scrollHeight: 1_000,
            clientHeight: 400,
        });
        const scrollTo = stubScrollTo(viewport);

        await wrapper.setProps({ followOutput: true });
        await settleLayout();

        expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: 'auto' });
    });

    it('user leaves follow mode when it is turned off', async () => {
        const wrapper = mountScroller({ followOutput: true });
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, {
            scrollTop: 600,
            scrollHeight: 1_000,
            clientHeight: 400,
        });
        stubScrollTo(viewport);
        await settleLayout();

        await wrapper.setProps({ followOutput: false });
        await settleLayout();

        expect(wrapper.emitted('followChange')).toContainEqual([false]);
    });

    it('user sees the rail update when the conversation changes', async () => {
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 1_200, clientHeight: 400 });
        triggerResize();
        await settleLayout();

        await wrapper.setProps({
            items: [...items, { id: 'a2', label: 'Then ship it.' }],
        });
        await settleLayout();

        expect(wrapper.findAll('[data-slot="message-scroller-rail-item"]')).toHaveLength(
            items.length + 1
        );
    });

    it('user can still reach the end when the scroll API is unavailable', async () => {
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 1_000, clientHeight: 400 });
        const scroller = wrapper.vm as unknown as MessageScrollerHandle;
        Object.defineProperty(viewport, 'scrollTo', {
            configurable: true,
            value: undefined,
        });

        scroller.scrollToEnd('auto');
        expect(viewport.scrollTop).toBe(600);

        Object.defineProperty(viewport, 'scrollTo', {
            configurable: true,
            value: vi.fn(() => {
                throw new Error('unsupported');
            }),
        });
        viewport.scrollTop = 0;
        scroller.scrollToEnd('auto');
        expect(viewport.scrollTop).toBe(600);
    });
});

describe('user prefers reduced motion', () => {
    it('user gets an instant jump when reduced motion is requested', async () => {
        vi.stubGlobal(
            'matchMedia',
            vi.fn().mockReturnValue({
                matches: true,
                media: '(prefers-reduced-motion: reduce)',
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            })
        );
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 1_600, clientHeight: 400 });
        const scrollTo = stubScrollTo(viewport);
        stubRect(viewport, { top: 0, height: 400 });
        const secondMessage = wrapper.get('[data-message-scroller-item="a1"]')
            .element as HTMLElement;
        stubRect(secondMessage, { top: 800, height: 100 });
        triggerResize();
        await settleLayout();

        await wrapper.findAll('[data-slot="message-scroller-rail-item"]')[1]!.trigger('click');
        await nextTick();

        expect(scrollTo).toHaveBeenCalledWith({ top: 650, behavior: 'auto' });
    });

    it('user gets an instant jump to the latest message even when smooth scrolling was requested', () => {
        vi.stubGlobal(
            'matchMedia',
            vi.fn().mockReturnValue({
                matches: true,
                media: '(prefers-reduced-motion: reduce)',
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            })
        );
        const wrapper = mountScroller();
        const viewport = viewportOf(wrapper);
        setScrollMetrics(viewport, { scrollHeight: 1_600, clientHeight: 400 });
        const scrollTo = stubScrollTo(viewport);

        const scroller = wrapper.vm as unknown as MessageScrollerHandle;
        scroller.scrollToEnd('smooth');

        expect(scrollTo).toHaveBeenCalledWith({ top: 1_200, behavior: 'auto' });
    });
});
