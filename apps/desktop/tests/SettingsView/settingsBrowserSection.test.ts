import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import BrowserSettingsView from '@/views/SettingsView/components/Browser/index.vue';

const updateBrowserSettingsMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/stores/settings', async () => {
    const { DEFAULT_BROWSER_SETTINGS } = await import('@/config/browserSettings');
    const { ref } = await import('vue');
    const settingsRef = ref({
        browserSettings: {
            ...DEFAULT_BROWSER_SETTINGS,
            defaultHomepage: 'https://example.test/home',
            browserExecutablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
            browserDataPath: 'D:/TouchAI/BrowserData',
        },
    });

    return {
        useSettingsStore: () => ({
            settings: settingsRef,
            updateBrowserSettings: updateBrowserSettingsMock,
        }),
    };
});

vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        name: 'CustomSelect',
        props: ['modelValue', 'options', 'disabled'],
        emits: ['update:modelValue'],
        template:
            '<select data-testid="custom-select" :disabled="disabled" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
    },
}));

describe('Browser settings section', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        setLocale('zh-CN');
        vi.useFakeTimers();
        updateBrowserSettingsMock.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders dedicated browser controls and auto-saves edits through settings store', async () => {
        const wrapper = mount(BrowserSettingsView);

        expect(wrapper.get('[data-testid="browser-settings-title"]').text()).toContain('浏览器控制');
        expect(wrapper.get('[data-testid="browser-enabled-toggle"]')).toBeTruthy();
        expect(wrapper.text()).toContain('管理 TouchAI 控制浏览器的行为。');
        expect(wrapper.text()).not.toContain('可在本页设置默认主页');
        expect(wrapper.get('[data-testid="browser-data-path-input"]').element).toMatchObject({
            value: 'D:/TouchAI/BrowserData',
        });
        expect(wrapper.text()).toContain('留空时使用 TouchAI 数据目录');
        expect(wrapper.get('[data-testid="browser-data-path-input"]').attributes('placeholder')).toBe(
            'D:\\TouchAI\\BrowserData'
        );
        expect(wrapper.get('[data-testid="browser-executable-path-input"]').element).toMatchObject({
            value: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        });
        expect(wrapper.get('[data-testid="browser-executable-path-input"]').attributes('placeholder')).toBe(
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        );
        expect(wrapper.get('[data-testid="browser-default-homepage-input"]').element).toMatchObject({
            value: 'https://example.test/home',
        });
        expect(wrapper.get('[data-testid="browser-default-homepage-input"]').attributes('placeholder')).toBe(
            'https://touch-ai.org'
        );
        expect(wrapper.text()).toContain('连接已有会话');
        expect(wrapper.text()).toContain('询问');
        expect(wrapper.text()).toContain('权限模式');
        expect(wrapper.text()).toContain('始终允许');
        expect(wrapper.text()).toContain('自动');
        expect(wrapper.text()).toContain('拒绝');
        expect(wrapper.text()).not.toContain('启用功能');
        expect(wrapper.text()).toContain('权限');
        expect(wrapper.text()).toContain('白名单域名');
        expect(wrapper.text()).toContain('黑名单域名');
        expect(wrapper.text()).toContain('高级');
        expect(wrapper.text()).toContain('指纹模拟');
        expect(wrapper.text()).toContain('基础');
        expect(wrapper.text()).toContain('增强');
        expect(wrapper.text()).not.toContain('指纹兼容');
        expect(wrapper.text()).not.toContain('兼容模式');
        expect(wrapper.text()).not.toContain('增强指纹处理');
        expect(wrapper.text()).toContain('User-Agent 是浏览器告诉网站的身份信息');
        expect(wrapper.text()).toContain('窗口大小，如 1366,768');
        expect(wrapper.text().indexOf('权限')).toBeLessThan(wrapper.text().indexOf('黑名单域名'));
        expect(wrapper.text().indexOf('白名单域名')).toBeLessThan(wrapper.text().indexOf('高级'));
        expect(wrapper.text()).not.toContain('TouchAI 绝不会打开这些网站');
        expect(wrapper.text()).not.toContain('无需询问即可打开的域名');
        expect(wrapper.find('[data-testid="browser-save-button"]').exists()).toBe(false);

        await wrapper
            .get('[data-testid="browser-default-homepage-input"]')
            .setValue('https://example.test/next');
        await vi.advanceTimersByTimeAsync(300);

        expect(updateBrowserSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({ defaultHomepage: 'https://example.test/next' })
        );
    });

    it('shows detailed permission rows only in automatic permission mode', async () => {
        const wrapper = mount(BrowserSettingsView);
        const selects = wrapper.findAll('[data-testid="custom-select"]');
        const permissionModeSelect = selects[1];
        expect(permissionModeSelect).toBeDefined();

        expect(wrapper.text()).toContain('浏览/跳转');
        expect(wrapper.text()).toContain('会话管理');

        await permissionModeSelect!.setValue('allow');

        expect(wrapper.text()).not.toContain('浏览/跳转');
        expect(wrapper.text()).not.toContain('会话管理');
        await vi.advanceTimersByTimeAsync(300);
        expect(updateBrowserSettingsMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ permissionMode: 'allow' })
        );
    });

    it('disables browser settings controls when the feature is off', async () => {
        const wrapper = mount(BrowserSettingsView);

        await wrapper.get('[data-testid="browser-enabled-toggle"]').trigger('click');

        expect(wrapper.get('[data-testid="browser-data-path-input"]').attributes('disabled')).toBeDefined();
        expect(
            wrapper.get('[data-testid="browser-executable-path-input"]').attributes('disabled')
        ).toBeDefined();
        expect(
            wrapper.get('[data-testid="browser-default-homepage-input"]').attributes('disabled')
        ).toBeDefined();
        expect(wrapper.find('[data-testid="custom-select"]').attributes('disabled')).toBeDefined();
    });

    it('renders browser settings copy in English when locale is English', () => {
        setLocale('en-US');

        const wrapper = mount(BrowserSettingsView);

        expect(wrapper.get('[data-testid="browser-settings-title"]').text()).toContain(
            'Browser Control'
        );
        expect(wrapper.text()).toContain('Manage how TouchAI controls browser behavior.');
        expect(wrapper.text()).toContain('Data');
        expect(wrapper.text()).toContain('Permissions');
        expect(wrapper.text()).toContain('Permission mode');
        expect(wrapper.text()).toContain('Always allow');
        expect(wrapper.text()).toContain('Ask');
        expect(wrapper.text()).toContain('Blocklist domains');
        expect(wrapper.text()).toContain('Allowlist domains');
        expect(wrapper.text()).toContain('Advanced');
        expect(wrapper.text()).toContain('Fingerprint simulation');
        expect(wrapper.text()).toContain(
            'User-Agent is the identity information the browser sends to websites'
        );
        expect(wrapper.text()).not.toContain('浏览器控制');
        expect(wrapper.text()).not.toContain('权限模式');
    });
});
