import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import BuiltInToolConfig from '@/views/SettingsView/components/BuiltInTools/components/BuiltInToolConfig.vue';
import type { BuiltInToolEntity } from '@/views/SettingsView/components/BuiltInTools/types';

function createTool(patch: Partial<BuiltInToolEntity> = {}): BuiltInToolEntity {
    return {
        id: 1,
        tool_id: 'browser',
        display_name: 'Browser',
        description: null,
        enabled: 1,
        risk_level: 'high',
        config_json: null,
        last_used_at: null,
        created_at: '2026-06-03T00:00:00.000Z',
        updated_at: '2026-06-03T00:00:00.000Z',
        ...patch,
    };
}

describe('browser automation built-in tool configuration', () => {
    it('does not render browser-specific configuration inside built-in tools', () => {
        setLocale('en-US');

        const wrapper = mount(BuiltInToolConfig, {
            props: {
                tool: createTool({
                    config_json: JSON.stringify({
                        mode: 'custom',
                        browserId: 'chrome',
                        startupUrl: 'https://example.test/start',
                    }),
                }),
            },
        });

        expect(wrapper.text()).toContain('This tool does not need configuration here');
        expect(wrapper.find('[data-testid="browser-id"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="browser-startup-url"]').exists()).toBe(false);
        expect(wrapper.emitted('save')).toBeUndefined();
    });
});
