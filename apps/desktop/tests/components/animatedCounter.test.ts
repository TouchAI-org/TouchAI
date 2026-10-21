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

describe('AnimatedCounter', () => {
    it('renders the value with prefix and suffix', () => {
        const wrapper = mount(AnimatedCounter, {
            props: { value: 12.63, prefix: '¥', decimals: 2, locale: 'en-US' },
        });

        expect(wrapper.text()).toContain('¥12.63');
    });

    it('exposes the final value for tests and assistive tech', () => {
        const wrapper = mount(AnimatedCounter, {
            props: { value: 1234, suffix: '万', locale: 'en-US' },
        });

        expect(wrapper.get('[data-value]').attributes('data-value')).toBe('1,234万');
    });

    it('never renders an intermediate value as the readable value', async () => {
        const wrapper = mount(AnimatedCounter, {
            props: { value: 10, locale: 'en-US' },
        });

        await wrapper.setProps({ value: 99 });

        // 动画中间态只影响画面，data-value 始终是目标值
        expect(wrapper.get('[data-value]').attributes('data-value')).toBe('99');
    });

    it('formats fractions with the requested decimals', () => {
        const wrapper = mount(AnimatedCounter, {
            props: { value: 5, decimals: 2, locale: 'en-US' },
        });

        expect(wrapper.text()).toContain('5.00');
    });

    it('shows the given text verbatim when text is provided', () => {
        const wrapper = mount(AnimatedCounter, {
            props: { value: 0, text: '41分' },
        });

        expect(wrapper.text()).toContain('41分');
        expect(wrapper.get('[data-value]').attributes('data-value')).toBe('41分');
    });
});
