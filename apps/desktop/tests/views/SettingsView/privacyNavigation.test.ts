import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import NavigationSidebar from '@/views/SettingsView/components/NavigationSidebar.vue';

import { useTestPrivacyApi } from '../../utils/privacyApi';

enableAutoUnmount(afterEach);
useTestPrivacyApi();

describe('given the settings sidebar is open', () => {
    it('user can open privacy protection by clicking its navigation entry', async () => {
        const wrapper = mount(NavigationSidebar, {
            props: { activeSection: 'general' },
        });

        const entry = wrapper.get('[data-testid="settings-nav-privacy-filter"]');
        expect(entry.text()).toBe('隐私保护');
        await entry.trigger('click');

        expect(wrapper.emitted('navigate')).toEqual([['privacy-filter']]);
    });
});
