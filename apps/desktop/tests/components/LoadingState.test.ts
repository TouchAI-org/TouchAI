import LoadingState from '@components/LoadingState.vue';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';

describe('LoadingState', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('uses the supplied cursor outline without a logo image or visible loading text', () => {
        const wrapper = mount(LoadingState, {
            props: { variant: 'brand', message: '正在加载模型服务设置...' },
        });

        expect(wrapper.find('img').exists()).toBe(false);
        expect(wrapper.find('p').exists()).toBe(false);
        expect(wrapper.text()).toBe('');
        expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe(
            '正在加载模型服务设置...'
        );
        const cursor = wrapper.get('svg');
        expect(cursor.attributes('viewBox')).toBe('29 32 50 52');
        expect(cursor.get('path[pathLength="1"]').attributes('d')).toContain(
            'M33.4842 50.9088L69.5842 35.1088'
        );
        wrapper.unmount();
    });

    it('keeps sweep gradients unique when multiple loading indicators are mounted', () => {
        const wrapper = mount({
            components: { LoadingState },
            template: '<div><LoadingState variant="brand" /><LoadingState variant="brand" /></div>',
        });
        const [first, second] = wrapper.findAllComponents(LoadingState);
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        const firstGradient = first!.get('linearGradient').attributes('id');
        const secondGradient = second!.get('linearGradient').attributes('id');

        expect(firstGradient).toBeTruthy();
        expect(secondGradient).not.toBe(firstGradient);
        expect(first!.get('path[pathLength="1"]').attributes('stroke')).toBe(
            `url(#${firstGradient})`
        );
        wrapper.unmount();
    });

    it('localizes the accessible loading label without adding visible copy', () => {
        setLocale('en-US');
        const wrapper = mount(LoadingState);

        expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('Loading...');
        expect(wrapper.text()).toBe('');
        wrapper.unmount();
    });
});
