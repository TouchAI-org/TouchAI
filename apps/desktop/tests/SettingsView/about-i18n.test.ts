import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import AboutSection from '@/views/SettingsView/components/About/index.vue';

vi.mock('@tauri-apps/api/app', () => ({
    getTauriVersion: vi.fn(async () => '2.11.0'),
    getVersion: vi.fn(async () => '0.1.0'),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
    openUrl: vi.fn(async () => undefined),
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

async function flushMountedPromises() {
    for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
    }
}

describe('Settings About i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
        vi.clearAllMocks();
    });

    it('renders static about page copy in English without relying on DOM localization', async () => {
        setLocale('en-US');

        const wrapper = mount(AboutSection);
        await flushMountedPromises();

        expect(wrapper.text()).toContain('About TouchAI');
        expect(wrapper.text()).toContain('Global AI assistant');
        expect(wrapper.text()).toContain('Application information');
        expect(wrapper.text()).toContain('Application name');
        expect(wrapper.text()).toContain('Developer');
        expect(wrapper.text()).toContain('System information');
        expect(wrapper.text()).toContain('Operating system');
        expect(wrapper.text()).toContain('External links');
        expect(wrapper.text()).toContain('GitHub repository');
        expect(wrapper.text()).toContain('Documentation');
        expect(wrapper.text()).toContain('Feedback');
        expect(wrapper.text()).not.toContain('关于 TouchAI');
        expect(wrapper.text()).not.toContain('应用信息');
        expect(wrapper.text()).not.toContain('问题反馈');
    });
});
