import type { AppUpdateState } from '@services/AppUpdateService/types';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { APP_PRODUCT_CONFIG } from '@/config/product';
import { setLocale } from '@/i18n';
import AboutView from '@/views/SettingsView/components/About/index.vue';

const neutralRequirement = {
    required: false,
    minimumSupportedVersion: null,
    requiredSeverity: null,
    requiredReason: null,
    targetSatisfiesRequirement: true,
};

const latestUpdate = {
    version: '0.2.0',
    tag: 'v0.2.0',
    releaseUrl: `${APP_PRODUCT_CONFIG.repository.releasesUrl}/tag/v0.2.0`,
    publishedAt: '2026-05-22T09:00:00.000Z',
    prerelease: false,
    releaseNotes: 'Release notes from GitHub',
    downloads: [
        {
            kind: 'installer',
            name: 'TouchAI-0.2.0-windows-Setup.exe',
            url: `${APP_PRODUCT_CONFIG.repository.url}/releases/download/v0.2.0/TouchAI-0.2.0-windows-Setup.exe`,
            sizeBytes: 12_000_000,
        },
    ],
};

const baseUpdateState: AppUpdateState = {
    status: 'available',
    channel: 'stable',
    autoCheckEnabled: true,
    currentVersion: '0.1.0',
    availableUpdate: {
        version: '0.2.0',
        fileName: `${APP_PRODUCT_CONFIG.identifier}-0.2.0-full.nupkg`,
        notes: 'Bug fixes',
        sizeBytes: 12_000_000,
    },
    downloadedUpdate: null,
    latestUpdate,
    updateRequirement: neutralRequirement,
    downloadProgress: null,
    lastCheckedAt: '2026-05-22T10:00:00.000Z',
    error: null,
    unsupportedReason: null,
};

const appUpdateServiceMock = vi.hoisted(() => ({
    state: null as AppUpdateState | null,
    getState: vi.fn(() => appUpdateServiceMock.state),
    subscribe: vi.fn((listener: (state: AppUpdateState) => void) => {
        listener(appUpdateServiceMock.state as AppUpdateState);
        return () => undefined;
    }),
    initialize: vi.fn().mockResolvedValue(undefined),
    checkNow: vi.fn().mockResolvedValue(true),
    download: vi.fn().mockResolvedValue(true),
    install: vi.fn().mockResolvedValue(true),
    setChannel: vi.fn().mockResolvedValue(undefined),
    setAutoCheckEnabled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@services/AppUpdateService', () => ({
    appUpdateService: appUpdateServiceMock,
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        template: '<span />',
    },
}));

vi.mock('@tauri-apps/api/app', () => ({
    getVersion: vi.fn().mockResolvedValue('0.1.0'),
    getTauriVersion: vi.fn().mockResolvedValue('2.0.0'),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
    openUrl: vi.fn().mockResolvedValue(undefined),
}));

describe('Settings About update section', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
        appUpdateServiceMock.state = {
            ...baseUpdateState,
            availableUpdate: baseUpdateState.availableUpdate
                ? { ...baseUpdateState.availableUpdate }
                : null,
            updateRequirement: { ...neutralRequirement },
        };
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('shows available update actions and delegates user actions to AppUpdateService', async () => {
        const wrapper = mount(AboutView);

        await nextTick();
        await nextTick();

        expect(wrapper.text()).toContain('发现新版本 0.2.0');
        expect(wrapper.text()).toContain('最新版本 0.2.0');
        expect(wrapper.text()).not.toContain(baseUpdateState.availableUpdate!.fileName);

        await wrapper.get('[data-testid="settings-update-download"]').trigger('click');
        expect(appUpdateServiceMock.download).toHaveBeenCalledTimes(1);

        await wrapper.get('[data-testid="settings-update-auto-check"]').trigger('click');
        expect(appUpdateServiceMock.setAutoCheckEnabled).toHaveBeenCalledWith(false);

        await wrapper.get('[data-testid="settings-update-channel-beta"]').trigger('click');
        expect(appUpdateServiceMock.setChannel).toHaveBeenCalledWith('beta');
    });

    it('shows localized required update reasons instead of remote policy text', async () => {
        appUpdateServiceMock.state = {
            ...baseUpdateState,
            updateRequirement: {
                required: true,
                minimumSupportedVersion: '0.2.1',
                requiredSeverity: 'critical',
                requiredReason: 'Security update required',
                targetSatisfiesRequirement: true,
            },
        };

        const wrapper = mount(AboutView);

        await nextTick();
        await nextTick();

        expect(wrapper.text()).toContain('此版本存在关键问题，需要更新');
        expect(wrapper.text()).not.toContain('Security update required');
    });

    it('keeps raw update errors out of the primary failed status copy', async () => {
        appUpdateServiceMock.state = {
            ...baseUpdateState,
            status: 'failed',
            error: 'download failed: 504',
        };

        const wrapper = mount(AboutView);

        await nextTick();
        await nextTick();

        expect(wrapper.text()).toContain('更新检查失败');
        expect(wrapper.text()).toContain('原因：download failed: 504');
    });
});
