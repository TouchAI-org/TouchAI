import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import TrayView from '@/views/TrayView/index.vue';

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@services/NativeService', () => ({
    native: {
        window: {
            closeTrayMenu: vi.fn(),
            openSettingsWindow: vi.fn(),
        },
    },
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
    getCurrentWebviewWindow: () => ({
        listen: vi.fn(async () => vi.fn()),
    }),
    WebviewWindow: {
        getByLabel: vi.fn(async () => null),
    },
}));

vi.mock('@tauri-apps/plugin-process', () => ({
    exit: vi.fn(),
}));

describe('TrayView i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('renders concise English menu labels', () => {
        setLocale('en-US');

        const wrapper = mount(TrayView);

        expect(wrapper.text()).toContain('Show');
        expect(wrapper.text()).toContain('Settings');
        expect(wrapper.text()).toContain('Exit');
        expect(wrapper.text()).not.toContain('Show window');
        expect(wrapper.text()).not.toContain('????');
    });
});
