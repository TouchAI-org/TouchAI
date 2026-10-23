import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import MotionCollapse from '@/components/MotionCollapse.vue';

describe('user expands a collapsed section', () => {
    it('user lazy mounts content on first open and keeps it mounted during close', async () => {
        const wrapper = mount(MotionCollapse, {
            props: { open: false, lazy: true },
            slots: { default: '<div data-testid="details">Details</div>' },
        });
        const panel = wrapper.find('.t-acc-panel');

        expect(wrapper.find('[data-testid="details"]').exists()).toBe(false);
        expect(panel.attributes('aria-hidden')).toBe('true');

        await wrapper.setProps({ open: true });
        expect(wrapper.find('[data-testid="details"]').exists()).toBe(true);
        expect(panel.attributes('aria-hidden')).toBe('false');

        await wrapper.setProps({ open: false });
        expect(wrapper.find('[data-testid="details"]').exists()).toBe(true);
        expect(panel.attributes('aria-hidden')).toBe('true');
        wrapper.unmount();
    });
});
