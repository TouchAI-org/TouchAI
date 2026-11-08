import StatusDivider from '@components/ui/status-divider/StatusDivider.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

describe('given a conversation status divider', () => {
    it('user sees progress become completed with the same spacing and a polite announcement', async () => {
        const wrapper = mount(StatusDivider, {
            props: { label: '正在压缩上下文', icon: 'compress', loading: true },
        });
        const status = wrapper.get('[role="status"]');
        expect(status.attributes()).toMatchObject({
            'aria-live': 'polite',
            'aria-atomic': 'true',
            'aria-busy': 'true',
        });
        expect(status.text()).toBe('正在压缩上下文');
        const loadingClasses = status.classes().sort();
        expect(loadingClasses).toMatchSnapshot('divider');
        expect(wrapper.get('svg').classes().sort()).toMatchSnapshot('loading icon');
        expect(
            wrapper.findAll('span[aria-hidden="true"]').map((line) => line.classes().sort())
        ).toMatchSnapshot('rules');

        await wrapper.setProps({ label: '上下文已压缩', loading: false });
        expect(status.attributes('aria-busy')).toBe('false');
        expect(status.text()).toBe('上下文已压缩');
        expect(status.classes().sort()).toEqual(loadingClasses);
        expect(wrapper.get('svg').classes().sort()).toMatchSnapshot('completed icon');
        wrapper.unmount();
    });
});
