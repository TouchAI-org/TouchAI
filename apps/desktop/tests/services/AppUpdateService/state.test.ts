import {
    createInitialAppUpdateState,
    reduceAppUpdateState,
} from '@services/AppUpdateService/state';
import type { AppUpdateCheckResult, AppUpdateState } from '@services/AppUpdateService/types';
import { describe, expect, it } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

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
    releaseNotes: '## 更新日志\n\n- 修复问题',
    downloads: [
        {
            kind: 'installer',
            name: 'TouchAI-0.2.0-windows.msi',
            url: `${APP_PRODUCT_CONFIG.services.updates.baseUrl}/TouchAI-0.2.0-windows.msi`,
            sizeBytes: 12_000_000,
        },
    ],
};

const availableUpdate: AppUpdateCheckResult = {
    status: 'available',
    channel: 'stable',
    currentVersion: '0.1.0',
    latest: latestUpdate,
    update: {
        version: '0.2.0',
        fileName: `${APP_PRODUCT_CONFIG.identifier}-0.2.0-full.nupkg`,
        notes: 'Bug fixes',
        sizeBytes: 12_000_000,
    },
    requirement: neutralRequirement,
};

describe('AppUpdateService state reducer', () => {
    it('creates an idle state with auto-check enabled by default', () => {
        expect(createInitialAppUpdateState()).toEqual({
            status: 'idle',
            channel: 'stable',
            autoCheckEnabled: true,
            currentVersion: null,
            availableUpdate: null,
            downloadedUpdate: null,
            latestUpdate: null,
            updateRequirement: null,
            downloadProgress: null,
            lastCheckedAt: null,
            error: null,
            unsupportedReason: null,
        } satisfies AppUpdateState);
    });

    it('records unsupported environments without treating them as failures', () => {
        const state = reduceAppUpdateState(createInitialAppUpdateState(), {
            type: 'check-completed',
            channel: 'stable',
            checkedAt: '2026-05-22T10:00:00.000Z',
            result: {
                status: 'unsupported',
                channel: 'stable',
                currentVersion: '0.1.0',
                latest: latestUpdate,
                reason: 'not_installed',
                message: 'Updates are available after installing TouchAI.',
                requirement: neutralRequirement,
            },
        });

        expect(state).toMatchObject({
            status: 'unsupported',
            currentVersion: '0.1.0',
            latestUpdate,
            lastCheckedAt: '2026-05-22T10:00:00.000Z',
            unsupportedReason: 'not_installed',
            error: null,
        });
    });

    it('records available updates and clears stale errors', () => {
        const state = reduceAppUpdateState(
            {
                ...createInitialAppUpdateState(),
                status: 'failed',
                error: 'network failed',
            },
            {
                type: 'check-completed',
                channel: 'stable',
                checkedAt: '2026-05-22T10:00:00.000Z',
                result: availableUpdate,
            }
        );

        expect(state).toMatchObject({
            status: 'available',
            currentVersion: '0.1.0',
            availableUpdate: availableUpdate.update,
            latestUpdate,
            updateRequirement: neutralRequirement,
            error: null,
        });
    });

    it('records channel latest metadata when no Velopack update is available', () => {
        const state = reduceAppUpdateState(createInitialAppUpdateState(), {
            type: 'check-completed',
            channel: 'stable',
            checkedAt: '2026-05-22T10:00:00.000Z',
            result: {
                status: 'not_available',
                channel: 'stable',
                currentVersion: '0.2.0',
                latest: latestUpdate,
                requirement: neutralRequirement,
            },
        });

        expect(state).toMatchObject({
            status: 'not_available',
            currentVersion: '0.2.0',
            latestUpdate,
            availableUpdate: null,
        });
    });

    it('records forced update requirements from check results', () => {
        const requirement = {
            required: true,
            minimumSupportedVersion: '0.2.1',
            requiredSeverity: 'critical',
            requiredReason: 'Security update required',
            targetSatisfiesRequirement: true,
        };

        const state = reduceAppUpdateState(createInitialAppUpdateState(), {
            type: 'check-completed',
            channel: 'stable',
            checkedAt: '2026-05-22T10:00:00.000Z',
            result: {
                ...availableUpdate,
                requirement,
            },
        });

        expect(state.updateRequirement).toEqual(requirement);
    });

    it('tracks download progress and the downloaded update', () => {
        const available = reduceAppUpdateState(createInitialAppUpdateState(), {
            type: 'check-completed',
            channel: 'stable',
            checkedAt: '2026-05-22T10:00:00.000Z',
            result: availableUpdate,
        });

        const downloading = reduceAppUpdateState(available, { type: 'download-started' });
        const progressed = reduceAppUpdateState(downloading, {
            type: 'download-progress',
            progress: 42,
        });
        const downloaded = reduceAppUpdateState(progressed, {
            type: 'download-completed',
            update: availableUpdate.update,
        });

        expect(downloading).toMatchObject({
            status: 'downloading',
            downloadProgress: 0,
        });
        expect(progressed).toMatchObject({
            status: 'downloading',
            downloadProgress: 42,
        });
        expect(downloaded).toMatchObject({
            status: 'downloaded',
            downloadedUpdate: availableUpdate.update,
            downloadProgress: 100,
        });
    });

    it('ignores stale download progress after a download finishes', () => {
        const downloaded = reduceAppUpdateState(
            {
                ...createInitialAppUpdateState(),
                status: 'downloaded',
                downloadedUpdate: availableUpdate.update,
                downloadProgress: 100,
            },
            {
                type: 'download-progress',
                progress: 64,
            }
        );

        expect(downloaded).toMatchObject({
            status: 'downloaded',
            downloadedUpdate: availableUpdate.update,
            downloadProgress: 100,
        });
    });

    it('ignores stale download completion after the user switches channels', () => {
        const switched = reduceAppUpdateState(
            {
                ...createInitialAppUpdateState(),
                status: 'idle',
                channel: 'nightly',
                availableUpdate: null,
                downloadedUpdate: null,
                downloadProgress: null,
            },
            {
                type: 'download-completed',
                update: availableUpdate.update,
            }
        );

        expect(switched).toMatchObject({
            status: 'idle',
            channel: 'nightly',
            downloadedUpdate: null,
            downloadProgress: null,
        });
    });

    it('ignores stale failures after the user leaves an in-flight updater operation', () => {
        const switched = reduceAppUpdateState(
            {
                ...createInitialAppUpdateState(),
                status: 'idle',
                channel: 'nightly',
                error: null,
            },
            {
                type: 'failed',
                error: 'download failed',
            }
        );

        expect(switched).toMatchObject({
            status: 'idle',
            channel: 'nightly',
            error: null,
        });
    });

    it('records installing and failed states', () => {
        const installing = reduceAppUpdateState(createInitialAppUpdateState(), {
            type: 'install-started',
        });
        const failed = reduceAppUpdateState(installing, {
            type: 'failed',
            error: 'install failed',
        });

        expect(installing.status).toBe('installing');
        expect(failed).toMatchObject({
            status: 'failed',
            error: 'install failed',
        });
    });

    it('clears stale update results when switching channels', () => {
        const available = reduceAppUpdateState(createInitialAppUpdateState(), {
            type: 'check-completed',
            channel: 'stable',
            checkedAt: '2026-05-22T10:00:00.000Z',
            result: availableUpdate,
        });

        const switched = reduceAppUpdateState(available, {
            type: 'channel-updated',
            channel: 'beta',
        });

        expect(switched).toMatchObject({
            status: 'idle',
            channel: 'beta',
            availableUpdate: null,
            downloadedUpdate: null,
            latestUpdate: null,
            updateRequirement: null,
            downloadProgress: null,
            lastCheckedAt: null,
            error: null,
        });
    });

    it('ignores a completed check if the user has already switched channels', () => {
        const checking = reduceAppUpdateState(createInitialAppUpdateState(), {
            type: 'check-started',
            channel: 'stable',
        });
        const switched = reduceAppUpdateState(checking, {
            type: 'channel-updated',
            channel: 'nightly',
        });

        const staleResult = reduceAppUpdateState(switched, {
            type: 'check-completed',
            channel: 'stable',
            checkedAt: '2026-05-22T10:00:00.000Z',
            result: availableUpdate,
        });

        expect(staleResult).toEqual(switched);
    });
});
