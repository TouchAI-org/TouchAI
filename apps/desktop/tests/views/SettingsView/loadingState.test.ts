import { mount } from '@vue/test-utils';

import LoadingState from '@/components/LoadingState.vue';

describe('LoadingState', () => {
    it('renders the shared TouchAI logo loading without copy when using the brand variant', () => {
        const wrapper = mount(LoadingState, {
            props: {
                variant: 'brand',
                fill: 'screen',
            },
        });

        expect(wrapper.find('img[alt="TouchAI"]').exists()).toBe(true);
        expect(wrapper.text()).toBe('');
    });

    it('keeps the spinner-and-message variant available for generic loading states', () => {
        const wrapper = mount(LoadingState, {
            props: {
                message: '正在加载数据...',
                fill: 'min',
            },
        });

        expect(wrapper.find('img[alt="TouchAI"]').exists()).toBe(false);
        expect(wrapper.text()).toContain('正在加载数据...');
    });
});
