import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import NavigationSidebar from '@/views/SettingsView/components/NavigationSidebar.vue';

describe('when the user points at a settings section', () => {
    it('user gets that section warmed up on hover without navigating to it', async () => {
        const wrapper = mount(NavigationSidebar, {
            props: { activeSection: 'general' },
        });

        const buttons = wrapper.findAll('button');
        for (const button of buttons) {
            await button.trigger('mouseenter');
        }

        expect(wrapper.emitted('prefetch-section')).toBeTruthy();
        expect(wrapper.emitted('navigate')).toBeFalsy();
        wrapper.unmount();
    });

    it('user gets the same warm-up when a section receives keyboard focus', async () => {
        const wrapper = mount(NavigationSidebar, {
            props: { activeSection: 'general' },
        });

        for (const button of wrapper.findAll('button')) {
            await button.trigger('focus');
        }

        expect(wrapper.emitted('prefetch-section')).toBeTruthy();
        wrapper.unmount();
    });
});
