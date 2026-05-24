import {
    createInitialAppUpdateState,
    reduceAppUpdateState,
} from '@services/AppUpdateService/state';
import type { AppUpdateCheckResult, AppUpdateState } from '@services/AppUpdateService/types';
import { describe, expect, it } from 'vitest';

const availableUpdate: AppUpdateCheckResult = {
    status: 'available',
    channel: 'stable',
    currentVersion: '0.1.0',
    update: {
        version: '0.2.0',
        fileName: 'org.touch-ai.app-0.2.0-full.nupkg',
        notes: 'Bug fixes',
        sizeBytes: 12_000_000,
    },
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
                reason: 'not_installed',
                message: 'Updates are available after installing TouchAI.',
            },
        });

        expect(state).toMatchObject({
            status: 'unsupported',
            currentVersion: '0.1.0',
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
            error: null,
        });
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
