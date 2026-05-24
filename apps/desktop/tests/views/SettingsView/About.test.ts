import type { AppUpdateState } from '@services/AppUpdateService/types';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import AboutView from '@/views/SettingsView/components/About/index.vue';

const updateState: AppUpdateState = {
    status: 'available',
    channel: 'stable',
    autoCheckEnabled: true,
    currentVersion: '0.1.0',
    availableUpdate: {
        version: '0.2.0',
        fileName: 'org.touch-ai.app-0.2.0-full.nupkg',
        notes: 'Bug fixes',
        sizeBytes: 12_000_000,
    },
    downloadedUpdate: null,
    downloadProgress: null,
    lastCheckedAt: '2026-05-22T10:00:00.000Z',
    error: null,
    unsupportedReason: null,
};

const appUpdateServiceMock = vi.hoisted(() => ({
    getState: vi.fn(() => updateState),
    subscribe: vi.fn((listener: (state: AppUpdateState) => void) => {
        listener(updateState);
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
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('shows available update actions and delegates user actions to AppUpdateService', async () => {
        const wrapper = mount(AboutView);

        await nextTick();
        await nextTick();

        expect(wrapper.text()).toContain('发现新版本 0.2.0');

        await wrapper.get('[data-testid="settings-update-download"]').trigger('click');
        expect(appUpdateServiceMock.download).toHaveBeenCalledTimes(1);

        await wrapper.get('[data-testid="settings-update-auto-check"]').trigger('click');
        expect(appUpdateServiceMock.setAutoCheckEnabled).toHaveBeenCalledWith(false);

        await wrapper.get('[data-testid="settings-update-channel-beta"]').trigger('click');
        expect(appUpdateServiceMock.setChannel).toHaveBeenCalledWith('beta');
    });
});
