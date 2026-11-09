import StatusDivider from '@components/ui/status-divider/StatusDivider.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

describe('given a conversation status divider', () => {
    it('user sees progress become completed with the same spacing without replaying live announcements', async () => {
        const wrapper = mount(StatusDivider, {
            props: { label: '正在压缩上下文', icon: 'compress', loading: true },
        });
        expect(wrapper.attributes('aria-live')).toBe('off');
        expect(wrapper.find('[role="status"], [aria-busy]').exists()).toBe(false);
        expect(wrapper.text()).toBe('正在压缩上下文');
        expect(wrapper.get('svg').classes()).not.toContain('animate-spin');
        expect(wrapper.find('.t-text-shimmer').text()).toBe('正在压缩上下文');
        const icon = wrapper.get('svg').html();
        const loadingClasses = wrapper.classes().sort();
        expect(loadingClasses).toMatchSnapshot('divider');
        expect(wrapper.get('svg').classes().sort()).toMatchSnapshot('loading icon');
        expect(
            wrapper.findAll('span[aria-hidden="true"]').map((line) => line.classes().sort())
        ).toMatchSnapshot('rules');

        await wrapper.setProps({ label: '上下文已压缩', loading: false });
        expect(wrapper.text()).toBe('上下文已压缩');
        expect(wrapper.get('svg').html()).toBe(icon);
        expect(wrapper.find('.t-text-shimmer').exists()).toBe(false);
        expect(wrapper.classes().sort()).toEqual(loadingClasses);
        expect(wrapper.get('svg').classes().sort()).toMatchSnapshot('completed icon');
        wrapper.unmount();
    });
});
