import { mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import BrowserSettingsView from '@/views/SettingsView/components/Browser/index.vue';

const updateBrowserSettingsMock = vi.hoisted(() => vi.fn(async () => undefined));
const browserSettingsPatch = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));
const DEFAULT_BROWSER_DATA_PATH = 'C:/Users/test/AppData/Roaming/TouchAI/browser-data';

vi.mock('@/stores/settings', async () => {
    const { DEFAULT_BROWSER_SETTINGS } = await import('@/stores/setting/sections/browser');
    const { ref } = await import('vue');

    return {
        useSettingsStore: () => {
            const settingsRef = ref({
                browserSettings: {
                    ...DEFAULT_BROWSER_SETTINGS,
                    defaultHomepage: 'https://example.test/home',
                    browserExecutablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
                    browserDataPath: 'D:/TouchAI/BrowserData',
                    ...browserSettingsPatch.value,
                },
            });

            return {
                settings: settingsRef,
                updateBrowserSettings: updateBrowserSettingsMock,
            };
        },
    };
});

vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        name: 'CustomSelect',
        props: ['modelValue', 'options', 'disabled'],
        emits: ['update:modelValue'],
        template:
            '<select data-testid="custom-select" :disabled="disabled" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}{{ option.description ? "|" + option.description : "" }}</option></select>',
    },
}));

describe('Browser settings section', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        setLocale('zh-CN');
        vi.useFakeTimers();
        updateBrowserSettingsMock.mockClear();
        browserSettingsPatch.value = {};
        mockTauriCommand('browser_discover_installed', [
            {
                id: 'chrome',
                name: 'Google Chrome',
                path: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
            },
            {
                id: 'edge',
                name: 'Microsoft Edge',
                path: 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
            },
        ]);
        mockTauriCommand('browser_default_data_path', DEFAULT_BROWSER_DATA_PATH);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders dedicated browser controls and auto-saves edits through settings store', async () => {
        const wrapper = mount(BrowserSettingsView);

        expect(wrapper.get('[data-testid="browser-settings-title"]').text()).toContain(
            '?????'
        );
        expect(wrapper.get('[data-testid="browser-enabled-toggle"]')).toBeTruthy();
        expect(wrapper.text()).toContain('?? TouchAI ?????????');
        expect(wrapper.text()).not.toContain('??????????');
        expect(wrapper.get('[data-testid="browser-data-path-input"]').element).toMatchObject({
            value: 'D:/TouchAI/BrowserData',
        });
        expect(wrapper.text()).toContain('????? TouchAI ????');
        expect(
            wrapper.get('[data-testid="browser-data-path-input"]').attributes('placeholder')
        ).toBe('browser-data');
        await vi.runOnlyPendingTimersAsync();
        expect(wrapper.get('[data-testid="browser-executable-select"]').element).toMatchObject({
            value: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        });
        expect(wrapper.get('[data-testid="browser-executable-select"]').text()).toContain(
            'Google Chrome|C:/Program Files/Google/Chrome/Application/chrome.exe'
        );
        expect(wrapper.get('[data-testid="browser-executable-select"]').text()).toContain(
            'Microsoft Edge'
        );
        expect(wrapper.find('[data-testid="browser-executable-path-input"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="browser-default-homepage-input"]').element).toMatchObject(
            {
                value: 'https://example.test/home',
            }
        );
        expect(
            wrapper.get('[data-testid="browser-default-homepage-input"]').attributes('placeholder')
        ).toBe('https://touch-ai.org');
        expect(wrapper.text()).toContain('??????');
        expect(wrapper.text()).toContain('??');
        expect(wrapper.text()).toContain('????');
        expect(wrapper.text()).toContain('????');
        expect(wrapper.text()).toContain('??');
        expect(wrapper.text()).toContain('??');
        expect(wrapper.text()).not.toContain('????');
        expect(wrapper.text()).toContain('??');
        expect(wrapper.text()).toContain('?????');
        expect(wrapper.text()).toContain('?????');
        expect(wrapper.text()).toContain('??');
        expect(wrapper.text()).toContain('????');
        expect(wrapper.text()).toContain('??');
        expect(wrapper.text()).toContain('??');
        expect(wrapper.text()).not.toContain('????');
        expect(wrapper.text()).not.toContain('????');
        expect(wrapper.text()).not.toContain('??????');
        expect(wrapper.text()).toContain('User-Agent ?????????????');
        expect(wrapper.text()).toContain('?????? 1366,768');
        expect(wrapper.get('[data-testid="browser-window-width-input"]').element).toMatchObject({
            value: '1366',
        });
        expect(wrapper.get('[data-testid="browser-window-height-input"]').element).toMatchObject({
            value: '768',
        });
        expect(wrapper.get('[data-testid="browser-fingerprint-profile-row"]').classes()).toContain(
            'sm:grid-cols-[minmax(0,1fr)_320px]'
        );
        expect(wrapper.text().indexOf('??')).toBeLessThan(wrapper.text().indexOf('?????'));
        expect(wrapper.text().indexOf('?????')).toBeLessThan(wrapper.text().indexOf('??'));
        expect(wrapper.text()).not.toContain('TouchAI ?????????');
        expect(wrapper.text()).not.toContain('???????????');
        expect(wrapper.find('[data-testid="browser-save-button"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="browser-default-mode-select"]')).toBeTruthy();

        await wrapper.get('[data-testid="browser-default-mode-select"]').setValue('headless');
        await vi.advanceTimersByTimeAsync(300);

        expect(updateBrowserSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({ headless: true })
        );

        await wrapper
            .get('[data-testid="browser-default-homepage-input"]')
            .setValue('https://example.test/next');
        await vi.advanceTimersByTimeAsync(300);

        expect(updateBrowserSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({ defaultHomepage: 'https://example.test/next' })
        );
    });

    it('edits browser window size as separate width and height fields', async () => {
        const wrapper = mount(BrowserSettingsView);

        await wrapper.get('[data-testid="browser-window-width-input"]').setValue('1440');
        await wrapper.get('[data-testid="browser-window-height-input"]').setValue('900');
        await vi.advanceTimersByTimeAsync(300);

        expect(updateBrowserSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({ fingerprintWindowSize: '1440,900' })
        );
    });

    it('renders localized homepage validation text', async () => {
        const wrapper = mount(BrowserSettingsView);

        await wrapper
            .get('[data-testid="browser-default-homepage-input"]')
            .setValue('ftp://example.test');
        await vi.advanceTimersByTimeAsync(300);

        expect(wrapper.text()).toContain('?????? http ? https ??');
        expect(wrapper.text()).not.toContain('settings.browser.validation.invalidHomepage');
        expect(updateBrowserSettingsMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ defaultHomepage: 'ftp://example.test' })
        );
    });

    it('shows detailed permission rows only in automatic permission mode', async () => {
        const wrapper = mount(BrowserSettingsView);
        const permissionModeSelect = wrapper.get('[data-testid="browser-permission-mode-select"]');

        expect(wrapper.text()).toContain('??/??');
        expect(wrapper.text()).toContain('????');

        await permissionModeSelect.setValue('allow');

        expect(wrapper.text()).not.toContain('??/??');
        expect(wrapper.text()).not.toContain('????');
        await vi.advanceTimersByTimeAsync(300);
        expect(updateBrowserSettingsMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ permissionMode: 'allow' })
        );
    });

    it('disables browser settings controls when the feature is off', async () => {
        const wrapper = mount(BrowserSettingsView);

        await wrapper.get('[data-testid="browser-enabled-toggle"]').trigger('click');

        expect(
            wrapper.get('[data-testid="browser-data-path-input"]').attributes('disabled')
        ).toBeDefined();
        expect(
            wrapper.get('[data-testid="browser-executable-select"]').attributes('disabled')
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
        expect(wrapper.text()).toContain('Basics');
        expect(wrapper.text()).toContain('Default browser');
        expect(wrapper.text()).toContain('Custom browser location');
        expect(wrapper.text()).toContain('Permissions');
        expect(wrapper.text()).toContain('Permission mode');
        expect(wrapper.text()).toContain('Always allow');
        expect(wrapper.text()).toContain('Ask');
        expect(wrapper.text()).toContain('Blocklist domains');
        expect(wrapper.text()).toContain('Allowlist domains');
        expect(wrapper.text()).toContain('Advanced');
        expect(wrapper.text()).toContain('Default mode');
        expect(wrapper.text()).toContain('Headless mode');
        expect(wrapper.text()).toContain('Fingerprint simulation');
        expect(wrapper.text()).toContain(
            'User-Agent is the identity information the browser sends to websites'
        );
        expect(wrapper.text()).not.toContain('?????');
        expect(wrapper.text()).not.toContain('????');
    });

    it('shows the runtime default browser when no executable path is configured', async () => {
        browserSettingsPatch.value = { browserExecutablePath: '' };
        const wrapper = mount(BrowserSettingsView);
        await vi.runOnlyPendingTimersAsync();

        expect(wrapper.get('[data-testid="browser-executable-select"]').element).toMatchObject({
            value: 'default',
        });
        expect(wrapper.get('[data-testid="browser-executable-select"]').text()).toContain(
            'Google Chrome'
        );
        expect(wrapper.get('[data-testid="browser-executable-select"]').text()).toContain(
            '?????|????? Google Chrome'
        );
        expect(wrapper.get('[data-testid="browser-executable-select"]').text()).not.toContain(
            '????? Google Chrome - C:/Program Files/Google/Chrome/Application/chrome.exe'
        );
        expect(wrapper.find('[data-testid="browser-executable-path-input"]').exists()).toBe(false);
        expect(updateBrowserSettingsMock).not.toHaveBeenCalled();
    });

    it('shows the runtime default browser data path without saving it automatically', async () => {
        browserSettingsPatch.value = { browserDataPath: '' };
        const wrapper = mount(BrowserSettingsView);

        await flushPromises();

        expect(wrapper.get('[data-testid="browser-data-path-input"]').element).toMatchObject({
            value: DEFAULT_BROWSER_DATA_PATH,
        });
        expect(updateBrowserSettingsMock).not.toHaveBeenCalled();
    });

    it('shows the default homepage as the field value without saving it automatically', () => {
        browserSettingsPatch.value = { defaultHomepage: '' };
        const wrapper = mount(BrowserSettingsView);

        expect(wrapper.get('[data-testid="browser-default-homepage-input"]').element).toMatchObject(
            {
                value: 'https://touch-ai.org',
            }
        );
        expect(updateBrowserSettingsMock).not.toHaveBeenCalled();
    });

    it('renders and saves the existing browser session policy', async () => {
        browserSettingsPatch.value = { existingSessionPolicy: 'ask' };
        const wrapper = mount(BrowserSettingsView);

        expect(wrapper.text()).toContain('??????');

        await wrapper
            .get('[data-testid="browser-existing-session-policy-select"]')
            .setValue('deny');
        await vi.advanceTimersByTimeAsync(300);

        expect(updateBrowserSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({ existingSessionPolicy: 'deny' })
        );
    });

    it('switches to custom browser path editing without auto-saving a discovered path first', async () => {
        browserSettingsPatch.value = { browserExecutablePath: '' };
        const wrapper = mount(BrowserSettingsView);
        await vi.runOnlyPendingTimersAsync();

        await wrapper.get('[data-testid="browser-executable-select"]').setValue('custom');

        expect(
            (
                wrapper.get('[data-testid="browser-executable-path-input"]')
                    .element as HTMLInputElement
            ).value
        ).toBe('');
        expect(updateBrowserSettingsMock).not.toHaveBeenCalled();

        await wrapper
            .get('[data-testid="browser-executable-path-input"]')
            .setValue('D:/Browsers/Chrome/chrome.exe');
        await vi.advanceTimersByTimeAsync(300);

        expect(updateBrowserSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({ browserExecutablePath: 'D:/Browsers/Chrome/chrome.exe' })
        );
    });

    it('saves a discovered browser path when selecting a concrete browser', async () => {
        browserSettingsPatch.value = { browserExecutablePath: '' };
        const wrapper = mount(BrowserSettingsView);
        await vi.runOnlyPendingTimersAsync();

        await wrapper
            .get('[data-testid="browser-executable-select"]')
            .setValue('C:/Program Files/Microsoft/Edge/Application/msedge.exe');
        await vi.advanceTimersByTimeAsync(300);

        expect(wrapper.find('[data-testid="browser-executable-path-input"]').exists()).toBe(false);
        expect(updateBrowserSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({
                browserExecutablePath: 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
            })
        );
    });

    it('clears the custom browser path when switching back to the default browser', async () => {
        const wrapper = mount(BrowserSettingsView);

        await wrapper.get('[data-testid="browser-executable-select"]').setValue('default');
        await vi.advanceTimersByTimeAsync(300);

        expect(wrapper.find('[data-testid="browser-executable-path-input"]').exists()).toBe(false);
        expect(updateBrowserSettingsMock).toHaveBeenCalledWith(
            expect.objectContaining({ browserExecutablePath: '' })
        );
    });
});