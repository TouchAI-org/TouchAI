import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import NavigationSidebar from '@/views/SettingsView/components/NavigationSidebar.vue';

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

describe('Settings navigation sidebar i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('localizes icon-only navigation titles', () => {
        setLocale('en-US');

        const wrapper = mount(NavigationSidebar, {
            props: {
                activeSection: 'general',
            },
        });

        expect(wrapper.get('[data-testid="settings-nav-general"]').attributes('title')).toBe(
            'General settings'
        );
        expect(wrapper.get('[data-testid="settings-nav-ai-services"]').attributes('title')).toBe(
            'Model service settings'
        );
        expect(wrapper.get('[data-testid="settings-nav-built-in-tools"]').attributes('title')).toBe(
            'Built-in tools'
        );
        expect(wrapper.get('[data-testid="settings-nav-about"]').attributes('title')).toBe(
            'About'
        );
    });
});
