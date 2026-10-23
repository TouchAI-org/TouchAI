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

describe('user sees the update state change with each updater event', () => {
    it('user starts with automatic checks on and no update known', () => {
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

    it('user sees an unsupported-environment notice that is not an error', () => {
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

    it('user sees the available update and the stale error cleared', () => {
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

    it('user sees the latest release notes when the updater finds no package', () => {
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

    it('user sees a forced-update requirement', () => {
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

    it('user sees download progress and the finished download', () => {
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

    it('user keeps the finished download when late progress arrives', () => {
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

    it('user sees the new channel kept when an old download completes', () => {
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

    it('user does not see an old failure after switching channels', () => {
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

    it('user sees the install start and a later failure', () => {
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

    it('user sees the previous channel results cleared when switching', () => {
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

    it('user does not see results from a check started before switching channels', () => {
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
