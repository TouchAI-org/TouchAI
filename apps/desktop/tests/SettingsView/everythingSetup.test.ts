import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { everythingSetupApi, everythingSetupApiKey } from '@/app/api/settings/everything';
import { setLocale } from '@/i18n';
import type { QuickSearchStatus } from '@/platform/native';
import EverythingSetup from '@/views/SettingsView/components/Search/EverythingSetup.vue';
import { searchSettings } from '@/views/SettingsView/settingsSearch';

import { getTauriInvokeCalls, mockTauriCommand } from '../utils/tauri';

const unavailable: QuickSearchStatus = {
    provider: 'unavailable',
    db_loaded: false,
    index_warmed: false,
    last_refresh_ms: null,
    last_error: 'private-native-error C:\\Users\\Private\\secret.txt',
};
const preparing: QuickSearchStatus = {
    provider: 'everything',
    db_loaded: true,
    index_warmed: false,
    last_refresh_ms: null,
    last_error: 'private-index-error',
};
const ready: QuickSearchStatus = {
    provider: 'everything',
    db_loaded: true,
    index_warmed: true,
    last_refresh_ms: 20,
    last_error: null,
};

function platform(value: string) {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(value);
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(value);
}

function openSetup() {
    return mount(EverythingSetup, {
        global: {
            provide: {
                [everythingSetupApiKey]: everythingSetupApi,
            },
        },
    });
}

enableAutoUnmount(afterEach);

beforeEach(() => {
    vi.useFakeTimers();
    platform('Win32');
    setLocale('en-US');
    mockTauriCommand('quick_search_prepare_index', undefined);
    mockTauriCommand('quick_search_get_status', unavailable);
    mockTauriCommand('quick_search_install_everything', undefined);
});

afterEach(() => {
    vi.useRealTimers();
    setLocale('zh-CN');
});

describe('given Windows local search is not enabled', () => {
    it('user sees one compact install row without setup steps', async () => {
        const wrapper = openSetup();
        await vi.advanceTimersByTimeAsync(5000);

        expect(wrapper.get('[data-testid="everything-setup"]').text()).toContain(
            'Everything local search'
        );
        expect(wrapper.get('[data-testid="everything-status"]').text()).toBe('Not enabled');
        expect(wrapper.get('[data-testid="everything-install"]').text()).toBe('Install and enable');
        expect(wrapper.find('[data-testid="everything-steps"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain(unavailable.last_error);
        expect(wrapper.text()).not.toContain('C:\\Users');
    });

    it('user installs and enables Everything with one action instead of opening a download page', async () => {
        let installed = false;
        mockTauriCommand('quick_search_install_everything', () => {
            installed = true;
        });
        mockTauriCommand('quick_search_get_status', () => (installed ? ready : unavailable));
        const wrapper = openSetup();
        await vi.advanceTimersByTimeAsync(5000);

        await wrapper.get('[data-testid="everything-install"]').trigger('click');
        await flushPromises();

        expect(getTauriInvokeCalls('quick_search_install_everything')).toHaveLength(1);
        expect(getTauriInvokeCalls('quick_search_prepare_index')).toHaveLength(2);
        expect(getTauriInvokeCalls('plugin:opener|open_url')).toHaveLength(0);
        expect(wrapper.get('[data-testid="everything-status"]').text()).toBe('Enabled');
        expect(wrapper.find('[data-testid="everything-install"]').exists()).toBe(false);
    });

    it('user cannot start the install twice while it is running', async () => {
        let finishInstall!: () => void;
        mockTauriCommand(
            'quick_search_install_everything',
            () =>
                new Promise<void>((resolve) => {
                    finishInstall = resolve;
                })
        );
        const wrapper = openSetup();
        await vi.advanceTimersByTimeAsync(5000);

        await wrapper.get('[data-testid="everything-install"]').trigger('click');
        await flushPromises();

        const button = wrapper.get('[data-testid="everything-install"]');
        expect(wrapper.get('[data-testid="everything-status"]').text()).toBe('Installing…');
        expect(button.attributes('disabled')).toBeDefined();
        await button.trigger('click');
        expect(getTauriInvokeCalls('quick_search_install_everything')).toHaveLength(1);

        mockTauriCommand('quick_search_get_status', ready);
        finishInstall();
        await flushPromises();
        expect(wrapper.get('[data-testid="everything-status"]').text()).toBe('Enabled');
    });

    it('user sees indexing progress and the button stays disabled until search is ready', async () => {
        let installed = false;
        mockTauriCommand('quick_search_install_everything', () => {
            installed = true;
        });
        mockTauriCommand('quick_search_get_status', () => (installed ? preparing : unavailable));
        const wrapper = openSetup();
        await vi.advanceTimersByTimeAsync(5000);

        await wrapper.get('[data-testid="everything-install"]').trigger('click');
        await flushPromises();

        expect(wrapper.get('[data-testid="everything-status"]').text()).toBe('Building index…');
        expect(
            wrapper.get('[data-testid="everything-install"]').attributes('disabled')
        ).toBeDefined();
        expect(wrapper.text()).not.toContain(preparing.last_error);

        mockTauriCommand('quick_search_get_status', ready);
        await vi.advanceTimersByTimeAsync(500);
        expect(wrapper.get('[data-testid="everything-status"]').text()).toBe('Enabled');
    });

    it('user keeps seeing indexing progress when preparation takes longer than startup', async () => {
        mockTauriCommand('quick_search_get_status', preparing);
        const wrapper = openSetup();
        await vi.advanceTimersByTimeAsync(500);
        await wrapper.get('[data-testid="everything-install"]').trigger('click');
        await flushPromises();

        await vi.advanceTimersByTimeAsync(10000);

        expect(wrapper.get('[data-testid="everything-status"]').text()).toBe('Building index…');
        expect(
            wrapper.get('[data-testid="everything-install"]').attributes('disabled')
        ).toBeDefined();
        expect(getTauriInvokeCalls('quick_search_prepare_index').length).toBeGreaterThan(2);

        mockTauriCommand('quick_search_get_status', ready);
        await vi.advanceTimersByTimeAsync(500);
        expect(wrapper.get('[data-testid="everything-status"]').text()).toBe('Enabled');
    });

    it('user gets a retry when the installed app never becomes available', async () => {
        const wrapper = openSetup();
        await vi.advanceTimersByTimeAsync(500);

        await wrapper.get('[data-testid="everything-install"]').trigger('click');
        await flushPromises();
        await vi.advanceTimersByTimeAsync(5000);

        expect(wrapper.get('[data-testid="everything-status"]').text()).toBe('Install failed');
        expect(wrapper.get('[data-testid="everything-install"]').text()).toBe('Retry');
        expect(
            wrapper.get('[data-testid="everything-install"]').attributes('disabled')
        ).toBeUndefined();
    });

    it('user gets a safe retry after installation fails without native error details', async () => {
        let installed = false;
        mockTauriCommand('quick_search_install_everything', () => {
            if (!installed) return Promise.reject(unavailable.last_error);
        });
        mockTauriCommand('quick_search_get_status', () => (installed ? ready : unavailable));
        const wrapper = openSetup();
        await vi.advanceTimersByTimeAsync(5000);

        await wrapper.get('[data-testid="everything-install"]').trigger('click');
        await flushPromises();

        expect(wrapper.get('[data-testid="everything-status"]').text()).toBe('Install failed');
        expect(wrapper.get('[data-testid="everything-install"]').text()).toBe('Retry');
        expect(wrapper.text()).not.toContain(unavailable.last_error);

        installed = true;
        await wrapper.get('[data-testid="everything-install"]').trigger('click');
        await flushPromises();
        expect(wrapper.get('[data-testid="everything-status"]').text()).toBe('Enabled');
    });

    it('user reads the compact row in Chinese when changing locale', async () => {
        const wrapper = openSetup();
        await vi.advanceTimersByTimeAsync(5000);
        setLocale('zh-CN');
        await flushPromises();

        expect(wrapper.get('[data-testid="everything-setup"]').text()).toContain(
            'Everything 本地搜索'
        );
        expect(wrapper.get('[data-testid="everything-status"]').text()).toBe('未启用');
        expect(wrapper.get('[data-testid="everything-install"]').text()).toBe('安装并启用');
    });

    it('user finds the row when searching settings for Everything on Windows', () => {
        expect(searchSettings('Everything')).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ section: 'search', targetId: 'search-everything' }),
            ])
        );
    });

    it('user stops status polling after leaving while installation is pending', async () => {
        let finishInstall!: () => void;
        mockTauriCommand(
            'quick_search_install_everything',
            () =>
                new Promise<void>((resolve) => {
                    finishInstall = resolve;
                })
        );
        const wrapper = openSetup();
        await vi.advanceTimersByTimeAsync(5000);
        await wrapper.get('[data-testid="everything-install"]').trigger('click');
        await flushPromises();

        wrapper.unmount();
        finishInstall();
        const reads = getTauriInvokeCalls('quick_search_get_status').length;
        await vi.advanceTimersByTimeAsync(10000);

        expect(getTauriInvokeCalls('quick_search_get_status')).toHaveLength(reads);
    });
});

describe('given Windows local search is already ready', () => {
    it('user sees Enabled without an install action', async () => {
        mockTauriCommand('quick_search_get_status', ready);
        const wrapper = openSetup();
        await flushPromises();

        expect(wrapper.get('[data-testid="everything-status"]').text()).toBe('Enabled');
        expect(wrapper.find('[data-testid="everything-install"]').exists()).toBe(false);
        expect(getTauriInvokeCalls('quick_search_prepare_index')).toHaveLength(0);
    });
});

describe('given Everything is not a Windows dependency', () => {
    it.each(['MacIntel', 'Linux x86_64', 'unknown'])(
        'user sees no row or native probe on %s',
        async (value) => {
            platform(value);
            const wrapper = openSetup();
            await vi.advanceTimersByTimeAsync(5000);

            expect(wrapper.find('[data-testid="everything-setup"]').exists()).toBe(false);
            expect(getTauriInvokeCalls('quick_search_prepare_index')).toHaveLength(0);
            expect(getTauriInvokeCalls('quick_search_get_status')).toHaveLength(0);
            expect(getTauriInvokeCalls('quick_search_install_everything')).toHaveLength(0);
            expect(searchSettings('Everything')).toHaveLength(0);
        }
    );
});
