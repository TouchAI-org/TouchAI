import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AnimatedCounter from '@/components/ui/animated-counter/AnimatedCounter.vue';

/** jsdom 没有 matchMedia / IntersectionObserver */
class ObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}

beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', ObserverStub);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(performance.now());
        return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('user reads an animated number', () => {
    it('user sees the final value without counting when reduced motion is enabled', () => {
        const requestFrame = vi.fn();
        vi.stubGlobal('requestAnimationFrame', requestFrame);
        vi.stubGlobal('matchMedia', () => ({
            matches: true,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        }));
        const wrapper = mount(AnimatedCounter, { props: { value: 123, animateOnView: true } });
        expect(
            wrapper
                .findAll('[aria-hidden="true"]')
                .map((node) => node.text())
                .join('')
        ).toContain('123');
        expect(requestFrame).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('user stops an in-flight counter when reduced motion becomes active', async () => {
        let listener!: (event: { matches: boolean }) => void;
        vi.stubGlobal('matchMedia', () => ({
            matches: false,
            addEventListener: (_: string, callback: typeof listener) => {
                listener = callback;
            },
            removeEventListener: vi.fn(),
        }));
        const cancel = vi.fn();
        vi.stubGlobal('requestAnimationFrame', () => 42);
        vi.stubGlobal('cancelAnimationFrame', cancel);
        const wrapper = mount(AnimatedCounter, { props: { value: 10 } });
        await wrapper.setProps({ value: 123 });
        listener({ matches: true });
        await wrapper.vm.$nextTick();
        expect(cancel).toHaveBeenCalledWith(42);
        expect(
            wrapper
                .findAll('[aria-hidden="true"]')
                .map((node) => node.text())
                .join('')
        ).toContain('123');
        wrapper.unmount();
    });
    it('user sees the value with prefix and suffix', () => {
        const wrapper = mount(AnimatedCounter, {
            props: { value: 12.63, prefix: '¥', decimals: 2, locale: 'en-US' },
        });

        expect(wrapper.text()).toContain('¥12.63');
    });

    it('user exposes the final value for tests and assistive tech', () => {
        const wrapper = mount(AnimatedCounter, {
            props: { value: 1234, suffix: '万', locale: 'en-US' },
        });

        expect(wrapper.get('[data-value]').attributes('data-value')).toBe('1,234万');
    });

    it('user never renders an intermediate value as the readable value', async () => {
        const wrapper = mount(AnimatedCounter, {
            props: { value: 10, locale: 'en-US' },
        });

        await wrapper.setProps({ value: 99 });

        // 动画中间态只影响画面，data-value 始终是目标值
        expect(wrapper.get('[data-value]').attributes('data-value')).toBe('99');
    });

    it('user formats fractions with the requested decimals', () => {
        const wrapper = mount(AnimatedCounter, {
            props: { value: 5, decimals: 2, locale: 'en-US' },
        });

        expect(wrapper.text()).toContain('5.00');
    });

    it('user sees the given text verbatim when text is provided', () => {
        const wrapper = mount(AnimatedCounter, {
            props: { value: 0, text: '41分' },
        });

        expect(wrapper.text()).toContain('41分');
        expect(wrapper.get('[data-value]').attributes('data-value')).toBe('41分');
    });
});
