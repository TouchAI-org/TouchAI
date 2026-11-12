import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import BuiltInToolList from '@/views/SettingsView/components/BuiltInTools/components/BuiltInToolList.vue';
import {
    type BuiltInToolEntity,
    usesBuiltInToolEmptyConfig,
} from '@/views/SettingsView/components/BuiltInTools/types';

describe('given the skill tool has a detailed model-facing description', () => {
    it.each([
        ['zh-CN', '读取本机技能'],
        ['en-US', 'Read local skills'],
    ] as const)(
        'user sees a short summary in %s when opening built-in tools',
        (locale, summary) => {
            setLocale(locale);
            const tool: BuiltInToolEntity = {
                id: 1,
                tool_id: 'activate_skill',
                display_name: 'ActivateSkill',
                description: 'Lengthy model instructions and available skill metadata.',
                enabled: 1,
                risk_level: 'low',
                config_json: null,
                last_used_at: null,
                created_at: '',
                updated_at: '',
            };
            const wrapper = mount(BuiltInToolList, {
                props: { tools: [tool], selectedToolId: tool.tool_id },
            });
            expect(wrapper.text()).toContain(summary);
            expect(wrapper.text()).not.toContain(tool.description);
            expect(usesBuiltInToolEmptyConfig(tool.tool_id)).toBe(true);
            wrapper.unmount();
        }
    );
});
