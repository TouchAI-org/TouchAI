import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PasswordInput from '@/components/PasswordInput.vue';
import TitleBar from '@/components/TitleBar.vue';
import { setLocale } from '@/i18n';

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        close: vi.fn(),
        minimize: vi.fn(),
    }),
}));

describe('window chrome i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('localizes title bar tooltips and accessibility labels', () => {
        setLocale('en-US');

        const wrapper = mount(TitleBar);
        const buttons = wrapper.findAll('button');

        expect(buttons[0]?.attributes('title')).toBe('Minimize');
        expect(buttons[0]?.attributes('aria-label')).toBe('Minimize');
        expect(buttons[1]?.attributes('title')).toBe('Close');
        expect(buttons[1]?.attributes('aria-label')).toBe('Close');
    });

    it('localizes password visibility accessibility labels', async () => {
        setLocale('en-US');

        const wrapper = mount(PasswordInput, {
            props: {
                modelValue: '',
                placeholder: 'sk-...',
            },
        });
        const button = wrapper.get('button');

        expect(button.attributes('aria-label')).toBe('Show password');

        await button.trigger('click');

        expect(button.attributes('aria-label')).toBe('Hide password');
    });
});
