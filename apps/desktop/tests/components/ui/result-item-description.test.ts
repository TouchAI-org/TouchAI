import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { enableAutoUnmount, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';

import { ResultItem } from '@/components/ui/result-panel';
import { provideMotionPreferences } from '@/composables/useMotion';
import type { AnimationSpeed } from '@/config/motion';

enableAutoUnmount(afterEach);

const motionCss = readFileSync(resolve('src/styles/motion.css'), 'utf8');
const skillDescription =
    'Read a document and produce a concise summary, preserving the important decisions, open questions, and follow-up actions at the very end.';
const fileDescription =
    'D:/Documents/Research/Project notes/Previous reports/Meeting summaries/Decisions and follow-up actions.md';
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
let systemReduced = false;
let stylesheet: HTMLStyleElement;

beforeEach(() => {
    systemReduced = false;
    vi.stubGlobal('matchMedia', () => ({
        matches: systemReduced,
        addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) =>
            mediaListeners.add(listener),
        removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) =>
            mediaListeners.delete(listener),
    }));
    stylesheet = document.createElement('style');
    stylesheet.textContent = motionCss;
    document.head.append(stylesheet);
});

afterEach(() => {
    stylesheet.remove();
    mediaListeners.clear();
    vi.unstubAllGlobals();
});

// JSDOM has no layout or Web Animations; control only these browser boundaries.
function measureDescription(wrapper: VueWrapper, width = 160, contentWidth = 480) {
    const element = wrapper.get('.text-search-muted').element as HTMLElement;
    const size = { width, contentWidth };
    const animations: Animation[] = [];
    Object.defineProperties(element, {
        clientWidth: { get: () => size.width },
        scrollWidth: { get: () => size.contentWidth },
        animate: {
            value: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
                let playState: AnimationPlayState = 'running';
                const animation = {
                    get playState() {
                        return playState;
                    },
                    effect: {
                        getKeyframes: () => keyframes,
                        getTiming: () => ({ iterations: 1, ...options }),
                    },
                    cancel() {
                        playState = 'idle';
                    },
                } as unknown as Animation;
                animations.push(animation);
                return animation;
            },
        },
        getAnimations: {
            value: () => animations.filter((animation) => animation.playState !== 'idle'),
        },
    });
    return { element, size };
}

function mountRow(
    props: { description?: string; disabled?: boolean } = {},
    width = 160,
    contentWidth = 480
) {
    const wrapper = mount(ResultItem, {
        props: { label: 'Summary', description: skillDescription, ...props },
    });
    return { wrapper, ...measureDescription(wrapper, width, contentWidth) };
}

function revealTiming(element: HTMLElement) {
    const [animation] = element.getAnimations();
    expect(animation).toBeDefined();
    return animation!.effect!.getTiming();
}

describe('given a result description extends beyond its available line', () => {
    it('user given an overflowing description when selecting its row by keyboard then reads the hidden ending', async () => {
        const { wrapper, element } = mountRow();
        await wrapper.setProps({ highlighted: true });
        expect(revealTiming(element).fill).toBe('forwards');
        await wrapper.setProps({ highlighted: false });
        expect(element.getAnimations()).toEqual([]);
        expect(element.style.overflow).toBe('');
    });

    it('user given a selected row when hovering and leaving it then keeps the same description reveal until both states end', async () => {
        const { wrapper, element } = mountRow();
        await wrapper.setProps({ highlighted: true });
        revealTiming(element);
        const [animation] = element.getAnimations();
        await wrapper.trigger('mouseenter');
        await wrapper.trigger('mouseleave');
        expect(element.getAnimations()).toEqual([animation]);
        await wrapper.trigger('mouseenter');
        await wrapper.setProps({ highlighted: false });
        expect(element.getAnimations()).toEqual([animation]);
        await wrapper.trigger('mouseleave');
        expect(element.getAnimations()).toEqual([]);
    });

    it.each([
        ['skill', skillDescription],
        ['file', fileDescription],
    ])(
        'user reads the hidden %s description slowly after hovering the row',
        async (_, description) => {
            const { wrapper, element } = mountRow({ description });
            const label = wrapper.get('[data-slot="result-item-label"]').element;
            expect(element.getAnimations()).toEqual([]);
            await wrapper.trigger('mouseenter');

            const timing = revealTiming(element);
            expect(timing.delay).toBeGreaterThanOrEqual(500);
            expect(timing.delay).toBeLessThanOrEqual(1000);
            expect(Number(timing.duration) / 320).toBeGreaterThanOrEqual(25);
            expect(Number(timing.duration) / 320).toBeLessThanOrEqual(100);
            expect(timing.easing).toBe('linear');
            expect(timing.iterations).toBe(1);
            expect(timing.fill).toBe('forwards');
            expect((element.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes()).toEqual([
                { transform: 'translateX(0)' },
                { transform: 'translateX(-320px)' },
            ]);
            expect(element.style.overflow).toBe('visible');
            expect(element.textContent?.trim()).toBe(description);
            expect(wrapper.get('[data-slot="result-item-label"]').element).toBe(label);
            expect(wrapper.get('.text-search-muted').element).toBe(element);
            await wrapper.trigger('click');
            expect(wrapper.emitted('click')).toHaveLength(1);
        }
    );

    it('user returns to the beginning on leave and reveals the current overflow on reentry', async () => {
        const { wrapper, element, size } = mountRow();
        await wrapper.trigger('mouseenter');
        const firstDuration = Number(revealTiming(element).duration);
        await wrapper.trigger('mouseleave');
        expect(element.getAnimations()).toEqual([]);
        expect(element.style.overflow).toBe('');

        size.width = 320;
        await wrapper.trigger('mouseenter');
        expect(Number(revealTiming(element).duration)).toBe(firstDuration / 2);
        const keyframes = (element.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes();
        expect(keyframes[keyframes.length - 1]).toEqual({
            transform: 'translateX(-160px)',
        });
    });

    it('user sees replacement text from its beginning when the description changes during hover', async () => {
        const { wrapper, element } = mountRow();
        await wrapper.trigger('mouseenter');
        revealTiming(element);
        await wrapper.setProps({ description: 'A new description' });
        expect(element.getAnimations()).toEqual([]);
        expect(element.style.overflow).toBe('');
        expect(element.textContent?.trim()).toBe('A new description');
    });

    it('user leaves no active reveal after dismissing the result', async () => {
        const { wrapper, element } = mountRow();
        await wrapper.trigger('mouseenter');
        revealTiming(element);
        wrapper.unmount();
        expect(element.getAnimations()).toEqual([]);
    });
});

describe('given a result does not need a description reveal', () => {
    it.each([
        [160, 120],
        [160, 160],
        [0, 480],
    ])(
        'user sees stationary text when the line measures %s and the text measures %s',
        async (width, contentWidth) => {
            const { wrapper, element } = mountRow({}, width, contentWidth);
            await wrapper.trigger('mouseenter');
            expect(element.getAnimations()).toEqual([]);
            expect(element.style.overflow).toBe('');
        }
    );

    it('user keeps the stable two-line tile label when switching layouts during a reveal', async () => {
        const { wrapper, element } = mountRow();
        await wrapper.trigger('mouseenter');
        revealTiming(element);
        await wrapper.setProps({ layout: 'grid' });
        expect(element.getAnimations()).toEqual([]);
        expect(wrapper.text()).toBe('Summary');
        const label = wrapper.get('[data-slot="result-item-label"]');
        expect(label.classes()).toEqual(
            expect.arrayContaining(['line-clamp-2', 'h-10', 'text-center', 'leading-5'])
        );
        const className = label.attributes('class');
        await wrapper.trigger('mouseenter');
        expect(wrapper.get('[data-slot="result-item-label"]').element).toBe(label.element);
        expect(label.attributes('class')).toBe(className);
        expect(wrapper.find('.text-search-muted').exists()).toBe(false);
    });
});

describe('given motion or interaction is unavailable', () => {
    it('user sees stationary text while the result is disabled, including disabling during hover', async () => {
        const { wrapper, element } = mountRow({ disabled: true });
        await wrapper.trigger('mouseenter');
        expect(element.getAnimations()).toEqual([]);
        await wrapper.setProps({ disabled: false });
        await wrapper.trigger('mouseenter');
        revealTiming(element);
        await wrapper.setProps({ disabled: true });
        expect(element.getAnimations()).toEqual([]);
        expect(element.style.overflow).toBe('');
    });

    it('user gets no reveal with reduced motion and can reveal again after changing the preference', async () => {
        systemReduced = true;
        const { wrapper, element } = mountRow();
        await wrapper.trigger('mouseenter');
        expect(element.getAnimations()).toEqual([]);
        mediaListeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent));
        await wrapper.trigger('mouseenter');
        revealTiming(element);
        mediaListeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent));
        expect(element.getAnimations()).toEqual([]);
        expect(element.style.overflow).toBe('');
    });

    it('user reads at the chosen motion speed through the shared window preference', async () => {
        const speed = ref<AnimationSpeed>('slower');
        const wrapper = mount(
            defineComponent({
                setup() {
                    provideMotionPreferences(speed, ref(false));
                    return () => h(ResultItem, { label: 'Summary', description: skillDescription });
                },
            })
        );
        const { element } = measureDescription(wrapper);
        await wrapper.trigger('mouseenter');
        const slower = revealTiming(element);
        await wrapper.trigger('mouseleave');
        speed.value = 'standard';
        await wrapper.trigger('mouseenter');
        const standard = revealTiming(element);
        expect(Number(slower.duration)).toBeCloseTo(Number(standard.duration) * 1.2);
        expect(slower.delay).toBeCloseTo(Number(standard.delay) * 1.2);
    });
});
