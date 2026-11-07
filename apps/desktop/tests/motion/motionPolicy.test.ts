import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';

import { provideMotionPreferences, useMotion } from '@/composables/useMotion';
import type { AnimationSpeed } from '@/config/motion';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('user receives one effective motion policy across components', () => {
    it('user gets normal motion on the first show after an initially hidden window', async () => {
        vi.useFakeTimers();
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => clock);
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
        let policy!: ReturnType<typeof provideMotionPreferences>;
        const wrapper = mount(
            defineComponent({
                setup() {
                    policy = provideMotionPreferences(ref('standard'), ref(true), false);
                    return () => h('div');
                },
            })
        );
        for (let index = 0; index < 2; index += 1) {
            clock += 1200;
            await vi.advanceTimersByTimeAsync(1000);
        }
        expect(policy.reducedMotion.value).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        policy.setWindowVisible(true);
        clock += 1000;
        await vi.advanceTimersByTimeAsync(1000);
        expect(policy.duration(320)).toBe(320);
        wrapper.unmount();
    });

    it('user changes speed live while the system preference always takes precedence', async () => {
        let mediaListener: (event: { matches: boolean }) => void;
        const add = vi.fn((_, listener) => {
            mediaListener = listener;
        });
        const remove = vi.fn();
        vi.stubGlobal(
            'matchMedia',
            vi.fn(() => ({ matches: false, addEventListener: add, removeEventListener: remove }))
        );
        vi.stubGlobal(
            'getComputedStyle',
            vi.fn(() => ({
                getPropertyValue: (key: string) => (key === '--duration-quick-base' ? '150ms' : ''),
            }))
        );
        const speed = ref<AnimationSpeed>('standard');
        const automatic = ref(false);
        const consumers: ReturnType<typeof useMotion>[] = [];
        const Child = defineComponent({
            setup() {
                consumers.push(useMotion());
                return () => h('div');
            },
        });
        const wrapper = mount(
            defineComponent({
                setup() {
                    provideMotionPreferences(speed, automatic);
                    return () => [h(Child), h(Child)];
                },
            })
        );
        expect(add).toHaveBeenCalledOnce();
        speed.value = 'slower';
        await nextTick();
        expect(consumers[0]!.duration(320)).toBe(384);
        expect(consumers[1]!.transitions.value.quick.duration).toBe(0.18);
        expect(document.documentElement.style.getPropertyValue('--motion-duration-scale')).toBe(
            '1.2'
        );
        mediaListener!({ matches: true });
        await nextTick();
        speed.value = 'faster';
        expect(consumers.every((motion) => motion.duration(320) === 0)).toBe(true);
        expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(true);
        wrapper.unmount();
        expect(remove).toHaveBeenCalledOnce();
        expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(false);
    });

    it('user suppresses both CSS and programmatic animation during sustained response delays', async () => {
        vi.useFakeTimers();
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => clock);
        let motion!: ReturnType<typeof useMotion>;
        const Child = defineComponent({
            setup() {
                motion = useMotion();
                return () => h('div');
            },
        });
        const automatic = ref(true);
        const wrapper = mount(
            defineComponent({
                setup() {
                    provideMotionPreferences(ref('faster'), automatic);
                    return () => h(Child);
                },
            })
        );
        for (let i = 0; i < 2; i++) {
            clock += 1200;
            await vi.advanceTimersByTimeAsync(1000);
        }
        expect(motion.duration(320)).toBe(0);
        expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(true);
        automatic.value = false;
        await nextTick();
        expect(motion.duration(320)).toBe(208);
        expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        wrapper.unmount();
    });
});
