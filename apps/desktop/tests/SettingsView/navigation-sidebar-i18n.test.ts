import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import NavigationSidebar from '@/views/SettingsView/components/NavigationSidebar.vue';
import {
    flattenSettingsNavigation,
    getSettingsNavigationItem,
    settingsNavigationGroups,
} from '@/views/SettingsView/settingsNavigation';

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
            'General'
        );
        expect(wrapper.get('[data-testid="settings-nav-ai-services"]').attributes('title')).toBe(
            'Providers and models'
        );
        expect(wrapper.get('[data-testid="settings-nav-built-in-tools"]').attributes('title')).toBe(
            'Built-in tools'
        );
        expect(wrapper.get('[data-testid="settings-nav-app-use"]').attributes('title')).toBe(
            'App Use'
        );
        expect(wrapper.get('[data-testid="settings-nav-mcp-tools"]').attributes('title')).toBe(
            'MCP tools'
        );
        expect(
            wrapper.get('[data-testid="settings-nav-data-management"]').attributes('title')
        ).toBe('Data management');
        expect(wrapper.find('[data-testid="settings-nav-about"]').exists()).toBe(false);
    });

    it('keeps navigation labels and descriptions reactive to locale changes', () => {
        setLocale('en-US');

        expect(settingsNavigationGroups[0]?.label).toBe('Basics');
        expect(flattenSettingsNavigation().map((item) => item.label)).toEqual([
            'General',
            'Providers and models',
            'Built-in tools',
            'App Use',
            'MCP tools',
            'Data management',
        ]);
        expect(getSettingsNavigationItem('app-use')?.description).toBe(
            'Structured local application adapters, approvals, and limits'
        );
        expect(getSettingsNavigationItem('app-use')?.label).toBe('App Use');
        expect(getSettingsNavigationItem('mcp-tools')?.description).toBe(
            'External MCP servers and tool call logs'
        );

        setLocale('zh-CN');

        expect(settingsNavigationGroups[0]?.label).toBe('基础体验');
        expect(flattenSettingsNavigation().map((item) => item.label)).toContain('软件控制');
        expect(getSettingsNavigationItem('app-use')?.label).toBe('软件控制');
        expect(getSettingsNavigationItem('mcp-tools')?.description).toBe(
            '外部 MCP 服务器与工具调用日志'
        );
    });
});
