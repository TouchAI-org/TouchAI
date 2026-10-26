import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import type { WebSearchSource } from '@/services/BuiltInToolService/tools/webSearch/sources';
import WebSearchSourcesCard from '@/views/SearchView/components/ConversationPanel/components/WebSearchSourcesCard.vue';

/*
 * The card's own content and its collapsed/skeleton states are covered elsewhere.
 * What is left here are the rail interactions a user actually performs: turning the
 * mouse wheel into horizontal scrolling, dragging the rail with the mouse, and the
 * edge fades that tell them there is more to scroll.
 */

vi.mock('@components/MotionCollapse.vue', () => ({
    default: {
        name: 'MotionCollapse',
        props: ['open'],
        template: '<div v-if="open"><slot /></div>',
    },
}));

vi.mock('@/views/SearchView/components/WebSearch/SourceFavicon.vue', () => ({
    default: {
        name: 'SourceFavicon',
        props: ['source', 'size'],
        template: '<span class="favicon" />',
    },
}));

function source(overrides: Partial<WebSearchSource> = {}): WebSearchSource {
    return {
        id: 'src-1',
        index: 1,
        title: 'A result',
        url: 'https://docs.example.com/a',
        snippet: 'snippet',
        siteName: 'docs.example.com',
        ...overrides,
    } as WebSearchSource;
}

const BASE_PROPS = {
    verbText: 'Searched',
    summaryText: 'query',
    durationText: '611ms',
};

/** Gives the rail a real scrollable width so the scroll maths has something to do. */
function stubRailMetrics(
    wrapper: ReturnType<typeof mount>,
    metrics: { scrollWidth: number; clientWidth: number }
) {
    const rail = wrapper.find('[data-slot="web-search-sources"]').element as HTMLElement;
    Object.defineProperty(rail, 'scrollWidth', { configurable: true, value: metrics.scrollWidth });
    Object.defineProperty(rail, 'clientWidth', { configurable: true, value: metrics.clientWidth });
    rail.setPointerCapture = vi.fn();
    rail.releasePointerCapture = vi.fn();
    return rail;
}

function mountCard(props: Record<string, unknown> = {}) {
    return mount(WebSearchSourcesCard, {
        props: { ...BASE_PROPS, sources: [source(), source({ id: 's2' })], ...props },
        attachTo: document.body,
    });
}

/**
 * The card starts expanded (defaultOpen), so the scrollable rail is already in the
 * DOM. This guards that assumption for every rail test below.
 */
async function openCard(wrapper: ReturnType<typeof mount>) {
    expect(wrapper.find('.web-search-sources__trigger').exists()).toBe(true);
    expect(wrapper.find('[data-slot="web-search-sources"]').exists()).toBe(true);
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            disconnect() {}
        }
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('when the user turns the mouse wheel over the source rail', () => {
    it('user gets the rail scrolled sideways instead of the conversation scrolling', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 600, clientWidth: 300 });

        const event = new WheelEvent('wheel', {
            deltaY: 100,
            deltaX: 0,
            cancelable: true,
            bubbles: true,
        });
        rail.dispatchEvent(event);
        await nextTick();

        expect(event.defaultPrevented).toBe(true);
        expect(rail.scrollLeft).toBeGreaterThan(0);

        wrapper.unmount();
    });

    it('user gets the browser handling a purely horizontal wheel gesture natively', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 600, clientWidth: 300 });
        rail.scrollLeft = 0;

        const event = new WheelEvent('wheel', {
            deltaY: 0,
            deltaX: 80,
            cancelable: true,
            bubbles: true,
        });
        rail.dispatchEvent(event);
        await nextTick();

        // Trackpad sideways scrolling keeps its native behaviour and no damping is added.
        expect(event.defaultPrevented).toBe(false);
        expect(rail.scrollLeft).toBe(0);

        wrapper.unmount();
    });

    it('user gets no sideways scroll when every card already fits', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 300, clientWidth: 300 });

        const event = new WheelEvent('wheel', {
            deltaY: 100,
            deltaX: 0,
            cancelable: true,
            bubbles: true,
        });
        rail.dispatchEvent(event);
        await nextTick();

        expect(event.defaultPrevented).toBe(false);

        wrapper.unmount();
    });

    it('user gets the last notch still reaching the end of the list', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 600, clientWidth: 300 });
        rail.scrollLeft = 290;

        // A large final gesture overshoots the end; it must clamp rather than be dropped.
        const event = new WheelEvent('wheel', {
            deltaY: 500,
            deltaX: 0,
            cancelable: true,
            bubbles: true,
        });
        rail.dispatchEvent(event);
        await nextTick();

        expect(event.defaultPrevented).toBe(true);
        expect(rail.scrollLeft).toBe(300);

        wrapper.unmount();
    });

    it('user gets no scroll event swallowed when the wheel adds nothing', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 600, clientWidth: 300 });
        rail.scrollLeft = 300;

        // A zero-magnitude gesture cannot move the rail, so it is left to the browser.
        const event = new WheelEvent('wheel', {
            deltaY: 0,
            deltaX: 0,
            cancelable: true,
            bubbles: true,
        });
        rail.scrollLeft = 300;
        rail.dispatchEvent(event);
        await nextTick();

        expect(event.defaultPrevented).toBe(false);

        wrapper.unmount();
    });
});

describe('when the user drags the source rail with the mouse', () => {
    it('user gets the rail panned by the drag distance', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 600, clientWidth: 300 });
        rail.scrollLeft = 100;

        rail.dispatchEvent(
            new PointerEvent('pointerdown', {
                pointerId: 1,
                pointerType: 'mouse',
                button: 0,
                clientX: 200,
                bubbles: true,
            })
        );
        rail.dispatchEvent(
            new PointerEvent('pointermove', {
                pointerId: 1,
                clientX: 150,
                bubbles: true,
                cancelable: true,
            })
        );
        await nextTick();

        // Dragging left reveals content to the right, so the rail scrolls forwards.
        expect(rail.scrollLeft).toBe(150);

        wrapper.unmount();
    });

    it('user gets the dragging style applied only while actually dragging', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 600, clientWidth: 300 });

        rail.dispatchEvent(
            new PointerEvent('pointerdown', {
                pointerId: 1,
                pointerType: 'mouse',
                button: 0,
                clientX: 200,
                bubbles: true,
            })
        );
        rail.dispatchEvent(
            new PointerEvent('pointermove', { pointerId: 1, clientX: 150, bubbles: true })
        );
        await nextTick();
        expect(rail.className).toContain('web-search-sources__rail--dragging');

        rail.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
        await nextTick();
        expect(rail.className).not.toContain('web-search-sources__rail--dragging');

        wrapper.unmount();
    });

    it('user gets no drag for a touch gesture so the page can scroll normally', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 600, clientWidth: 300 });
        rail.scrollLeft = 100;

        rail.dispatchEvent(
            new PointerEvent('pointerdown', {
                pointerId: 1,
                pointerType: 'touch',
                button: 0,
                clientX: 200,
                bubbles: true,
            })
        );
        rail.dispatchEvent(
            new PointerEvent('pointermove', { pointerId: 1, clientX: 50, bubbles: true })
        );
        await nextTick();

        expect(rail.scrollLeft).toBe(100);

        wrapper.unmount();
    });

    it('user gets no drag from a non-primary mouse button', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 600, clientWidth: 300 });
        rail.scrollLeft = 100;

        rail.dispatchEvent(
            new PointerEvent('pointerdown', {
                pointerId: 1,
                pointerType: 'mouse',
                button: 2,
                clientX: 200,
                bubbles: true,
            })
        );
        rail.dispatchEvent(
            new PointerEvent('pointermove', { pointerId: 1, clientX: 50, bubbles: true })
        );
        await nextTick();

        expect(rail.scrollLeft).toBe(100);

        wrapper.unmount();
    });

    it('user gets the tap treated as a click when the pointer barely moved', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 600, clientWidth: 300 });
        rail.scrollLeft = 100;

        rail.dispatchEvent(
            new PointerEvent('pointerdown', {
                pointerId: 1,
                pointerType: 'mouse',
                button: 0,
                clientX: 200,
                bubbles: true,
            })
        );
        // Two pixels of jitter is still a click, not a pan.
        rail.dispatchEvent(
            new PointerEvent('pointermove', { pointerId: 1, clientX: 198, bubbles: true })
        );
        await nextTick();

        expect(rail.scrollLeft).toBe(100);
        expect(rail.className).not.toContain('--dragging');

        wrapper.unmount();
    });

    it('user gets the card link not opened when the drag ends on it', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 600, clientWidth: 300 });

        rail.dispatchEvent(
            new PointerEvent('pointerdown', {
                pointerId: 1,
                pointerType: 'mouse',
                button: 0,
                clientX: 200,
                bubbles: true,
            })
        );
        rail.dispatchEvent(
            new PointerEvent('pointermove', { pointerId: 1, clientX: 140, bubbles: true })
        );
        rail.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
        await nextTick();

        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        rail.dispatchEvent(click);

        // The pan must not be read as "open this source".
        expect(click.defaultPrevented).toBe(true);

        wrapper.unmount();
    });

    it('user gets a real click opened normally when there was no drag', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 600, clientWidth: 300 });

        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        rail.dispatchEvent(click);

        expect(click.defaultPrevented).toBe(false);

        wrapper.unmount();
    });

    it('user gets the pointer release ignored when a different pointer ends the gesture', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 600, clientWidth: 300 });

        rail.dispatchEvent(
            new PointerEvent('pointerdown', {
                pointerId: 1,
                pointerType: 'mouse',
                button: 0,
                clientX: 200,
                bubbles: true,
            })
        );
        rail.dispatchEvent(new PointerEvent('pointerup', { pointerId: 99, bubbles: true }));
        await nextTick();

        // The stray pointerup must not release the capture owned by pointer 1.
        expect(rail.releasePointerCapture).not.toHaveBeenCalled();

        wrapper.unmount();
    });
});

describe('when the user scrolls the rail to its edges', () => {
    it('user sees the start fade disappear once the rail is scrolled to the very start', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 600, clientWidth: 300 });
        rail.scrollLeft = 0;

        rail.dispatchEvent(new Event('scroll'));
        await nextTick();

        expect(wrapper.find('.web-search-sources__fade--start').exists()).toBe(false);
        // There is more to the right, so the end fade is shown.
        expect(wrapper.find('.web-search-sources__fade--end').exists()).toBe(true);

        wrapper.unmount();
    });

    it('user sees the end fade disappear once the rail is scrolled to the very end', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 600, clientWidth: 300 });
        rail.scrollLeft = 300;

        rail.dispatchEvent(new Event('scroll'));
        await nextTick();

        expect(wrapper.find('.web-search-sources__fade--end').exists()).toBe(false);
        expect(wrapper.find('.web-search-sources__fade--start').exists()).toBe(true);

        wrapper.unmount();
    });

    it('user sees both fades while there is content on either side', async () => {
        const wrapper = mountCard();
        await openCard(wrapper);
        await nextTick();
        const rail = stubRailMetrics(wrapper, { scrollWidth: 900, clientWidth: 300 });
        rail.scrollLeft = 300;

        rail.dispatchEvent(new Event('scroll'));
        await nextTick();

        expect(wrapper.find('.web-search-sources__fade--start').exists()).toBe(true);
        expect(wrapper.find('.web-search-sources__fade--end').exists()).toBe(true);

        wrapper.unmount();
    });
});
