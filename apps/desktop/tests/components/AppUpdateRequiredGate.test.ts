import type { AppUpdateState } from '@services/AppUpdateService/types';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { APP_PRODUCT_CONFIG } from '@/config/product';
import AppUpdateRequiredGate from '@/components/AppUpdateRequiredGate.vue';

const neutralRequirement = {
    required: false,
    minimumSupportedVersion: null,
    requiredSeverity: null,
    requiredReason: null,
    targetSatisfiesRequirement: true,
};

const requiredRequirement = {
    required: true,
    minimumSupportedVersion: '0.2.1',
    requiredSeverity: 'critical',
    requiredReason: 'Security update required',
    targetSatisfiesRequirement: true,
};

const baseState: AppUpdateState = {
    status: 'idle',
    channel: 'stable',
    autoCheckEnabled: true,
    currentVersion: '0.2.0',
    availableUpdate: null,
    downloadedUpdate: null,
    updateRequirement: neutralRequirement,
    downloadProgress: null,
    lastCheckedAt: null,
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

vi.mock('@tauri-apps/plugin-opener', () => ({
    openUrl: vi.fn().mockResolvedValue(undefined),
}));

describe('AppUpdateRequiredGate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        appUpdateServiceMock.state = { ...baseState };
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('stays hidden when the current version is supported', async () => {
        const wrapper = mount(AppUpdateRequiredGate);
        await nextTick();

        expect(wrapper.find('[data-testid="app-update-required-gate"]').exists()).toBe(false);
    });

    it('blocks the app and downloads a satisfying required update', async () => {
        appUpdateServiceMock.state = {
            ...baseState,
            status: 'available',
            availableUpdate: {
                version: '0.2.1',
                fileName: `${APP_PRODUCT_CONFIG.identifier}-0.2.1-full.nupkg`,
                notes: 'Security fixes',
                sizeBytes: 12_000_000,
            },
            updateRequirement: requiredRequirement,
        };

        const wrapper = mount(AppUpdateRequiredGate);
        await nextTick();

        expect(wrapper.get('[data-testid="app-update-required-gate"]').text()).toContain(
            '当前版本已不再受支持'
        );
        expect(wrapper.text()).toContain('可更新到 0.2.1');
        expect(wrapper.text()).toContain('Security fixes');

        await wrapper.get('[data-testid="app-update-required-primary"]').trigger('click');

        expect(appUpdateServiceMock.download).toHaveBeenCalledTimes(1);
    });

    it('opens the release page when the channel has no satisfying update', async () => {
        appUpdateServiceMock.state = {
            ...baseState,
            status: 'not_available',
            updateRequirement: {
                ...requiredRequirement,
                targetSatisfiesRequirement: false,
            },
        };
        const { openUrl } = await import('@tauri-apps/plugin-opener');

        const wrapper = mount(AppUpdateRequiredGate);
        await nextTick();
        await wrapper.get('[data-testid="app-update-required-primary"]').trigger('click');

        expect(openUrl).toHaveBeenCalledWith(APP_PRODUCT_CONFIG.repository.releasesUrl);
    });
});
