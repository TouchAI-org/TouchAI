import { createUpdateClientBoundary } from '@tests/utils/updateClient';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import AppUpdateRequiredGate from '@/components/AppUpdateRequiredGate.vue';
import { APP_PRODUCT_CONFIG } from '@/config/product';
import { setLocale } from '@/i18n';
import type { AppUpdateState } from '@/modules/updates/types';

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

const latestUpdate = {
    version: '0.2.1',
    tag: 'v0.2.1',
    releaseUrl: `${APP_PRODUCT_CONFIG.repository.releasesUrl}/tag/v0.2.1`,
    publishedAt: '2026-05-22T09:00:00.000Z',
    prerelease: false,
    releaseNotes: '## 更新日志\n\n- 修复问题',
    downloads: [
        {
            kind: 'installer',
            name: 'TouchAI-0.2.1-windows.msi',
            url: `${APP_PRODUCT_CONFIG.services.updates.baseUrl}/TouchAI-0.2.1-windows.msi`,
            sizeBytes: 12_000_000,
        },
    ],
};

const baseState: AppUpdateState = {
    status: 'idle',
    channel: 'stable',
    autoCheckEnabled: true,
    currentVersion: '0.2.0',
    availableUpdate: null,
    downloadedUpdate: null,
    latestUpdate: null,
    updateRequirement: neutralRequirement,
    downloadProgress: null,
    lastCheckedAt: null,
    error: null,
    unsupportedReason: null,
};

let updatesBoundary: Awaited<ReturnType<typeof createUpdateClientBoundary>>;
vi.mock('@tauri-apps/plugin-opener', () => ({
    openUrl: vi.fn().mockResolvedValue(undefined),
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

describe('user must update before continuing', () => {
    beforeEach(async () => {
        updatesBoundary = await createUpdateClientBoundary();
        vi.clearAllMocks();
        setLocale('zh-CN');
        updatesBoundary.state = { ...baseState };
    });

    afterEach(async () => {
        await updatesBoundary.dispose();
        document.body.innerHTML = '';
    });

    it('user stays hidden when the current version is supported', async () => {
        await updatesBoundary.synchronize();
        const wrapper = mount(AppUpdateRequiredGate, updatesBoundary.viewOptions);
        await nextTick();

        expect(wrapper.find('[data-testid="app-update-required-gate"]').exists()).toBe(false);
    });

    it('user blocks the app and downloads a satisfying required update', async () => {
        updatesBoundary.state = {
            ...baseState,
            status: 'available',
            latestUpdate,
            availableUpdate: {
                version: '0.2.1',
                fileName: `${APP_PRODUCT_CONFIG.identifier}-0.2.1-full.nupkg`,
                notes: 'Security fixes',
                sizeBytes: 12_000_000,
            },
            updateRequirement: requiredRequirement,
        };

        await updatesBoundary.synchronize();
        const wrapper = mount(AppUpdateRequiredGate, updatesBoundary.viewOptions);
        await nextTick();

        expect(wrapper.get('[data-testid="app-update-required-gate"]').text()).toContain(
            '当前版本已不再受支持'
        );
        expect(wrapper.text()).toContain('可更新到 0.2.1');
        expect(wrapper.text()).toContain('此版本存在关键问题，需要更新');
        expect(wrapper.text()).not.toContain('Security update required');
        expect(wrapper.text()).toContain('Security fixes');

        await wrapper.get('[data-testid="app-update-required-primary"]').trigger('click');

        expect(updatesBoundary.download).toHaveBeenCalledTimes(1);
    });

    it('user opens the release page when no direct download is selected', async () => {
        const latestUpdateWithoutDirectDownload = {
            ...latestUpdate,
            downloads: [],
        };
        updatesBoundary.state = {
            ...baseState,
            status: 'not_available',
            latestUpdate: latestUpdateWithoutDirectDownload,
            updateRequirement: {
                ...requiredRequirement,
                targetSatisfiesRequirement: false,
            },
        };
        const { openUrl } = await import('@tauri-apps/plugin-opener');

        await updatesBoundary.synchronize();
        const wrapper = mount(AppUpdateRequiredGate, updatesBoundary.viewOptions);
        await nextTick();
        expect(wrapper.text()).toContain('可更新到 0.2.1');
        expect(wrapper.text()).toContain('修复问题');
        await wrapper.get('[data-testid="app-update-required-primary"]').trigger('click');

        expect(openUrl).toHaveBeenCalledWith(latestUpdateWithoutDirectDownload.releaseUrl);
    });

    it('user sees raw update errors only as localized details', async () => {
        updatesBoundary.state = {
            ...baseState,
            status: 'failed',
            error: 'download failed: 504',
            updateRequirement: requiredRequirement,
        };

        await updatesBoundary.synchronize();
        const wrapper = mount(AppUpdateRequiredGate, updatesBoundary.viewOptions);
        await nextTick();

        expect(wrapper.text()).toContain('原因：download failed: 504');
    });

    it('user can recheck an update while a package is already downloaded', async () => {
        const candidate = {
            version: '0.2.1',
            fileName: `${APP_PRODUCT_CONFIG.identifier}-0.2.1-full.nupkg`,
            notes: 'Security fixes',
            sizeBytes: 12_000_000,
        };
        updatesBoundary.state = {
            ...baseState,
            status: 'downloaded',
            latestUpdate,
            availableUpdate: candidate,
            downloadedUpdate: candidate,
            updateRequirement: requiredRequirement,
        };

        await updatesBoundary.synchronize();
        const wrapper = mount(AppUpdateRequiredGate, updatesBoundary.viewOptions);
        await nextTick();

        const recheck = wrapper.get('[data-testid="app-update-required-check"]');
        expect(recheck.attributes('disabled')).toBeUndefined();
        await recheck.trigger('click');

        expect(updatesBoundary.checkNow).toHaveBeenCalledWith('manual');

        await wrapper.get('[data-testid="app-update-required-primary"]').trigger('click');
        expect(updatesBoundary.install).toHaveBeenCalledOnce();
        wrapper.unmount();
    });

    it.each(['download', 'install'] as const)(
        'user retries a failed required %s without opening an external download',
        async (phase) => {
            const candidate = {
                version: '0.2.1',
                fileName: `${APP_PRODUCT_CONFIG.identifier}-0.2.1-full.nupkg`,
                notes: 'Security fixes',
                sizeBytes: 12_000_000,
            };
            updatesBoundary.state = {
                ...baseState,
                status: 'failed',
                latestUpdate,
                availableUpdate: candidate,
                downloadedUpdate: phase === 'install' ? candidate : null,
                updateRequirement: requiredRequirement,
                error: 'temporary failure',
            };
            const { openUrl } = await import('@tauri-apps/plugin-opener');
            await updatesBoundary.synchronize();
            const wrapper = mount(AppUpdateRequiredGate, updatesBoundary.viewOptions);
            await nextTick();

            await wrapper.get('[data-testid="app-update-required-primary"]').trigger('click');

            expect(updatesBoundary[phase]).toHaveBeenCalledOnce();
            expect(
                updatesBoundary[phase === 'install' ? 'download' : 'install']
            ).not.toHaveBeenCalled();
            expect(openUrl).not.toHaveBeenCalled();
            expect(wrapper.text()).toContain('temporary failure');
            wrapper.unmount();
        }
    );
});
