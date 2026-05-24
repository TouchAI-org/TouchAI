import { DEFAULT_APP_UPDATE_CHANNEL } from '@/config/appUpdate';

import type { AppUpdateAction, AppUpdateInfo, AppUpdateState } from './types';

function clampProgress(progress: number): number {
    if (!Number.isFinite(progress)) {
        return 0;
    }
    return Math.min(100, Math.max(0, Math.round(progress)));
}

export function createInitialAppUpdateState(): AppUpdateState {
    return {
        status: 'idle',
        channel: DEFAULT_APP_UPDATE_CHANNEL,
        autoCheckEnabled: true,
        currentVersion: null,
        availableUpdate: null,
        downloadedUpdate: null,
        updateRequirement: null,
        downloadProgress: null,
        lastCheckedAt: null,
        error: null,
        unsupportedReason: null,
    };
}

function resolveDownloadedUpdate(
    state: AppUpdateState,
    update: AppUpdateInfo | null | undefined
): AppUpdateInfo | null {
    return update ?? state.availableUpdate ?? state.downloadedUpdate;
}

export function reduceAppUpdateState(
    state: AppUpdateState,
    action: AppUpdateAction
): AppUpdateState {
    switch (action.type) {
        case 'settings-loaded':
            return {
                ...state,
                channel: action.channel,
                autoCheckEnabled: action.autoCheckEnabled,
                lastCheckedAt: action.lastCheckedAt,
            };
        case 'channel-updated':
            return {
                ...state,
                status: 'idle',
                channel: action.channel,
                currentVersion: null,
                availableUpdate: null,
                downloadedUpdate: null,
                updateRequirement: null,
                downloadProgress: null,
                lastCheckedAt: null,
                error: null,
                unsupportedReason: null,
            };
        case 'auto-check-updated':
            return {
                ...state,
                autoCheckEnabled: action.enabled,
            };
        case 'check-started':
            return {
                ...state,
                status: 'checking',
                channel: action.channel,
                error: null,
                unsupportedReason: null,
            };
        case 'check-completed':
            if (action.channel !== state.channel) {
                return state;
            }

            if (action.result.status === 'available') {
                return {
                    ...state,
                    status: 'available',
                    currentVersion: action.result.currentVersion,
                    availableUpdate: action.result.update,
                    downloadedUpdate: null,
                    updateRequirement: action.result.requirement,
                    downloadProgress: null,
                    lastCheckedAt: action.checkedAt,
                    error: null,
                    unsupportedReason: null,
                };
            }

            if (action.result.status === 'unsupported') {
                return {
                    ...state,
                    status: 'unsupported',
                    currentVersion: action.result.currentVersion,
                    availableUpdate: null,
                    downloadedUpdate: null,
                    updateRequirement: action.result.requirement,
                    downloadProgress: null,
                    lastCheckedAt: action.checkedAt,
                    error: null,
                    unsupportedReason: action.result.reason,
                };
            }

            return {
                ...state,
                status: 'not_available',
                currentVersion: action.result.currentVersion,
                availableUpdate: null,
                downloadedUpdate: null,
                updateRequirement: action.result.requirement,
                downloadProgress: null,
                lastCheckedAt: action.checkedAt,
                error: null,
                unsupportedReason: null,
            };
        case 'download-started':
            return {
                ...state,
                status: 'downloading',
                downloadProgress: 0,
                error: null,
            };
        case 'download-progress':
            return {
                ...state,
                status: 'downloading',
                downloadProgress: clampProgress(action.progress),
            };
        case 'download-completed':
            return {
                ...state,
                status: 'downloaded',
                downloadedUpdate: resolveDownloadedUpdate(state, action.update),
                downloadProgress: 100,
                error: null,
            };
        case 'install-started':
            return {
                ...state,
                status: 'installing',
                error: null,
            };
        case 'failed':
            return {
                ...state,
                status: 'failed',
                error: action.error,
            };
        default:
            return state;
    }
}
