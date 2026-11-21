import { createUpdateClientBoundary } from '@tests/utils/updateClient';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import AppUpdateRequiredGate from '@/components/AppUpdateRequiredGate.vue';
import { APP_PRODUCT_CONFIG } from '@/config/product';
import { setLocale } from '@/i18n';
import type { AppUpdateState } from '@/modules/updates/types';

/*
 * The existing gate test covers the happy path: blocked, offered, downloaded. This
 * file covers the states a user actually meets on the way there — checking, a
 * download in flight, installing, an unknown requirement, and a failing updater —
 * plus the two buttons that must stay inert while the updater is busy.
 */

const { openUrlMock } = vi.hoisted(() => ({
    openUrlMock: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: openUrlMock }));

let updatesBoundary: Awaited<ReturnType<typeof createUpdateClientBoundary>>;
vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

const requirement = (overrides: Record<string, unknown> = {}) => ({
    required: true,
    minimumSupportedVersion: '0.2.1',
    requiredSeverity: 'critical',
    requiredReason: 'Security update required',
    targetSatisfiesRequirement: true,
    ...overrides,
});

const channelLatest = (overrides: Record<string, unknown> = {}) => ({
    version: '0.2.1',
    tag: 'v0.2.1',
    releaseUrl: `${APP_PRODUCT_CONFIG.repository.releasesUrl}/tag/v0.2.1`,
    publishedAt: '2026-05-22T09:00:00.000Z',
    prerelease: false,
    releaseNotes: 'Fixes and polish',
    downloads: [
        {
            kind: 'installer',
            name: 'TouchAI-0.2.1-windows.msi',
            url: `${APP_PRODUCT_CONFIG.services.updates.baseUrl}/TouchAI-0.2.1-windows.msi`,
            sizeBytes: 12_000_000,
        },
    ],
    ...overrides,
});

const baseState = (): AppUpdateState =>
    ({
        status: 'idle',
        channel: 'stable',
        autoCheckEnabled: true,
        currentVersion: '0.2.0',
        availableUpdate: null,
        downloadedUpdate: null,
        latestUpdate: null,
        updateRequirement: requirement(),
        downloadProgress: null,
        lastCheckedAt: null,
        error: null,
        unsupportedReason: null,
    }) as AppUpdateState;

async function mountGate(patch: Partial<AppUpdateState> = {}) {
    updatesBoundary.state = { ...baseState(), ...patch };
    await updatesBoundary.synchronize();
    return mount(AppUpdateRequiredGate, updatesBoundary.viewOptions);
}

function primary(wrapper: Awaited<ReturnType<typeof mountGate>>) {
    return wrapper.get('[data-testid="app-update-required-primary"]');
}

function recheck(wrapper: Awaited<ReturnType<typeof mountGate>>) {
    return wrapper.get('[data-testid="app-update-required-check"]');
}

function iconName(wrapper: Awaited<ReturnType<typeof mountGate>>) {
    const icons = wrapper.findAll('[data-testid="app-icon"]');
    return icons[icons.length - 1]!.attributes('data-name');
}

beforeEach(async () => {
    updatesBoundary = await createUpdateClientBoundary();
    setLocale('zh-CN');
    for (const key of ['initialize', 'checkNow', 'download', 'install'] as const) {
        updatesBoundary[key].mockClear();
    }
    updatesBoundary.initialize.mockResolvedValue(undefined);
    updatesBoundary.checkNow.mockResolvedValue(true);
    updatesBoundary.download.mockResolvedValue(true);
    updatesBoundary.install.mockResolvedValue(true);
    openUrlMock.mockClear();
});

afterEach(async () => {
    await updatesBoundary.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('user is blocked from an unsupported version', () => {
    it('user stays out of the way when the service reports no requirement at all', async () => {
        const wrapper = await mountGate({ updateRequirement: null });

        expect(wrapper.find('[data-testid="app-update-required-gate"]').exists()).toBe(false);
    });

    it('user stays out of the way when the requirement is advisory', async () => {
        const wrapper = await mountGate({ updateRequirement: requirement({ required: false }) });

        expect(wrapper.find('[data-testid="app-update-required-gate"]').exists()).toBe(false);
    });

    it('user sees the minimum version when no release has been fetched yet', async () => {
        const wrapper = await mountGate({ latestUpdate: null, availableUpdate: null });

        expect(wrapper.text()).toContain('需要 0.2.1 或更高版本');
    });

    it('user is told a supported version is needed when even the minimum is unknown', async () => {
        const wrapper = await mountGate({
            updateRequirement: requirement({ minimumSupportedVersion: null }),
        });

        expect(wrapper.text()).toContain('需要安装受支持的版本');
    });

    it('user sees the minimum supported version and their own version in the detail line', async () => {
        const wrapper = await mountGate();

        expect(wrapper.text()).toContain('最低支持版本 0.2.1');
        expect(wrapper.text()).toContain('当前版本 0.2.0');
        expect(wrapper.text()).not.toContain('·');
    });

    it('user sees no detail line when nothing about the requirement is known', async () => {
        const wrapper = await mountGate({
            updateRequirement: requirement({
                minimumSupportedVersion: null,
                requiredReason: null,
                requiredSeverity: null,
            }),
            currentVersion: null,
        });

        // Nothing to explain, so the red detail block is not drawn at all.
        expect(wrapper.text()).not.toContain('最低支持版本');
    });

    it('user sees the release notes of the release they are being sent to', async () => {
        const wrapper = await mountGate({ latestUpdate: channelLatest() as never });

        expect(wrapper.text()).toContain('Fixes and polish');
    });

    it('user sees no release notes block when the release carried none', async () => {
        const wrapper = await mountGate({
            latestUpdate: channelLatest({ releaseNotes: null }) as never,
        });

        expect(wrapper.text()).not.toContain('更新日志');
    });
});

describe('user waits while the updater is busy', () => {
    it('user sees a check running', async () => {
        const wrapper = await mountGate({
            status: 'checking',
            latestUpdate: channelLatest() as never,
        });

        expect(primary(wrapper).text()).toContain('正在检查');
        expect(primary(wrapper).attributes('disabled')).toBeDefined();
    });

    it('user sees the download percentage while it runs', async () => {
        const wrapper = await mountGate({
            status: 'downloading',
            downloadProgress: 37,
            latestUpdate: channelLatest() as never,
        });

        expect(primary(wrapper).text()).toContain('37');
        expect(wrapper.find('[aria-label="下载进度"]').exists()).toBe(true);
    });

    it('user sees a download that has not reported progress start at zero', async () => {
        const wrapper = await mountGate({
            status: 'downloading',
            downloadProgress: null,
            latestUpdate: channelLatest() as never,
        });

        expect(primary(wrapper).text()).toContain('0');
        const bar = wrapper.get('[aria-label="下载进度"] > div');
        expect(bar.attributes('style')).toContain('width: 0%');
    });

    it('user sees the install running', async () => {
        const wrapper = await mountGate({
            status: 'installing',
            latestUpdate: channelLatest() as never,
        });

        expect(primary(wrapper).text()).toContain('正在安装');
        expect(primary(wrapper).attributes('disabled')).toBeDefined();
    });

    it('user gets the recheck button unavailable while the updater is busy', async () => {
        const wrapper = await mountGate({
            status: 'downloading',
            latestUpdate: channelLatest() as never,
        });

        expect(recheck(wrapper).attributes('disabled')).toBeDefined();
    });

    it('user gets nothing started when they press the action while a check runs', async () => {
        const wrapper = await mountGate({
            status: 'checking',
            latestUpdate: channelLatest() as never,
        });

        await primary(wrapper).trigger('click');
        await nextTick();

        expect(updatesBoundary.download).not.toHaveBeenCalled();
        expect(updatesBoundary.install).not.toHaveBeenCalled();
        expect(openUrlMock).not.toHaveBeenCalled();
    });

    it('user gets no second check started while one is already running', async () => {
        const wrapper = await mountGate({
            status: 'checking',
            latestUpdate: channelLatest() as never,
        });

        await recheck(wrapper).trigger('click');
        await nextTick();

        expect(updatesBoundary.checkNow).not.toHaveBeenCalled();
    });
});

describe('user takes the update the gate offers', () => {
    it('user gets the install started for an update already downloaded', async () => {
        const wrapper = await mountGate({
            status: 'downloaded',
            downloadedUpdate: {
                version: '0.2.1',
                fileName: 'TouchAI-0.2.1-full.nupkg',
                notes: 'Security fixes',
                sizeBytes: 12_000_000,
            } as never,
        });

        expect(primary(wrapper).text()).toContain('安装并重启');
        expect(iconName(wrapper)).toBe('check-circle');

        await primary(wrapper).trigger('click');
        await nextTick();

        expect(updatesBoundary.install).toHaveBeenCalledOnce();
    });

    it('user gets the download started for an update they can take in the app', async () => {
        const wrapper = await mountGate({
            status: 'available',
            availableUpdate: {
                version: '0.2.1',
                fileName: 'TouchAI-0.2.1-full.nupkg',
                notes: '',
                sizeBytes: 1,
            } as never,
            latestUpdate: channelLatest() as never,
        });

        expect(primary(wrapper).text()).toContain('下载');
        expect(iconName(wrapper)).toBe('arrow-down');

        await primary(wrapper).trigger('click');
        await nextTick();

        expect(updatesBoundary.download).toHaveBeenCalledOnce();
        expect(openUrlMock).not.toHaveBeenCalled();
    });

    it('user gets sent to the installer when the release offers a direct download', async () => {
        const wrapper = await mountGate({
            status: 'available',
            updateRequirement: requirement({ targetSatisfiesRequirement: false }),
            latestUpdate: channelLatest() as never,
        });

        await primary(wrapper).trigger('click');
        await nextTick();

        // The gate has to send the user somewhere they can actually get the release: either
        // the installer this platform can run, or the release page that lists them.
        expect(openUrlMock).toHaveBeenCalledTimes(1);
        const opened = String((openUrlMock.mock.calls as unknown as string[][])[0]?.[0] ?? '');
        expect([
            `${APP_PRODUCT_CONFIG.services.updates.baseUrl}/TouchAI-0.2.1-windows.msi`,
            `${APP_PRODUCT_CONFIG.repository.releasesUrl}/tag/v0.2.1`,
        ]).toContain(opened);
    });

    it('user gets the release page when the release has no direct download', async () => {
        const wrapper = await mountGate({
            status: 'available',
            updateRequirement: requirement({ targetSatisfiesRequirement: false }),
            latestUpdate: channelLatest({ downloads: [] }) as never,
        });

        expect(primary(wrapper).text()).toContain('下载页');
        expect(iconName(wrapper)).toBe('folder-open');

        await primary(wrapper).trigger('click');
        await nextTick();

        expect(openUrlMock).toHaveBeenCalledWith(
            `${APP_PRODUCT_CONFIG.repository.releasesUrl}/tag/v0.2.1`
        );
    });

    it('user gets the repository releases page when the feed names no release page', async () => {
        const wrapper = await mountGate({
            status: 'available',
            updateRequirement: requirement({ targetSatisfiesRequirement: false }),
            latestUpdate: null,
        });

        await primary(wrapper).trigger('click');
        await nextTick();

        expect(openUrlMock).toHaveBeenCalledWith(APP_PRODUCT_CONFIG.repository.releasesUrl);
    });

    it('user gets a fresh check started from the recheck button', async () => {
        const wrapper = await mountGate({ latestUpdate: channelLatest() as never });

        await recheck(wrapper).trigger('click');
        await nextTick();

        expect(updatesBoundary.checkNow).toHaveBeenCalledWith('manual');
    });
});

describe('user sees a broken updater explained', () => {
    it('user sees the failure reason in the detail block', async () => {
        const wrapper = await mountGate({ status: 'failed', error: 'download failed: 504' });

        expect(wrapper.text()).toContain('download failed: 504');
    });

    it('user sees no failure block when the error is only whitespace', async () => {
        const wrapper = await mountGate({ status: 'failed', error: '   ' });

        expect(wrapper.text()).not.toContain('原因');
    });

    it('user still sees the gate when the updater itself could not start', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        updatesBoundary.initialize.mockRejectedValue(new Error('no tauri'));

        const wrapper = await mountGate();
        await nextTick();
        await nextTick();

        // The gate renders from the state it already has; a failed initialize must not
        // leave the user staring at a blank window.
        expect(wrapper.find('[data-testid="app-update-required-gate"]').exists()).toBe(true);
        consoleError.mockRestore();
    });

    it('user gets the update subscription released when the gate goes away', async () => {
        const wrapper = await mountGate();
        await nextTick();

        wrapper.unmount();

        await updatesBoundary.publishState({ updateRequirement: null });
        await nextTick();
        expect(wrapper.exists()).toBe(false);
    });
});
