import { createSettingsPanelFixture, openSettingsSelect } from '@tests/utils/settingsPanel';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLocale, tt } from '@/i18n';
import GeneralSection from '@/views/SettingsView/components/General/index.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
const wrappers: VueWrapper[] = [];
beforeEach(async () => {
    fixture = await createSettingsPanelFixture({ values: { language: 'en-US' } });
});
afterEach(async () => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    await fixture.dispose();
    document.body.innerHTML = '';
    setLocale('zh-CN');
});

describe('user captures a shortcut in general settings', () => {
    it('user sees the shortcut capture prompt from source text', () => {
        setLocale('en-US');

        expect(tt('请按下快捷键...')).toBe('Press a shortcut...');
    });

    it('user sees general settings copy and option labels in English without DOM localization', async () => {
        setLocale('en-US');

        const wrapper = mount(GeneralSection, fixture.viewOptions);
        wrappers.push(wrapper);

        await flushPromises();

        expect(wrapper.text()).toContain('General');
        expect(wrapper.text()).toContain('Startup and window');
        expect(wrapper.text()).toContain(
            'Control startup behavior and the default search window size'
        );
        expect(wrapper.text()).toContain('Start on boot');
        expect(wrapper.text()).toContain('Start minimized');
        expect(wrapper.text()).toContain('Window size');
        expect(wrapper.text()).toContain('Conversation experience');
        expect(wrapper.text()).toContain('Output scroll behavior');
        expect(wrapper.text()).toContain('Follow output');
        const options = await openSettingsSelect(
            wrapper.get('[data-settings-search-target="output-scroll"] [role="combobox"]')
        );
        expect(options.map((option) => option.text()).join(' ')).toContain(
            'Automatically scroll to the latest content while output streams'
        );
        expect(wrapper.text()).toContain('Language');
        expect(wrapper.text()).toContain('Controls the display language used by TouchAI');
        expect(wrapper.text()).toContain('Interface language');
        expect(wrapper.text()).not.toContain('Activation shortcut');
        expect(wrapper.text()).not.toContain('Set the global shortcut used to open TouchAI.');
        expect(wrapper.text()).not.toContain('Toggle window maximize');
        expect(wrapper.text()).not.toContain('Toggle the search window maximized state.');
        expect(wrapper.text()).not.toContain('常规设置');
        expect(wrapper.text()).not.toContain('输出时滚动策略');
    });
});
