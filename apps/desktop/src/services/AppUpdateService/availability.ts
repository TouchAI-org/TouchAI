import gt from 'semver/functions/gt';
import valid from 'semver/functions/valid';

import { APP_VERSION } from '@/config/product';

import type { AppUpdateInfo, AppUpdateState } from './types';

function isNewerVersion(version: string, currentVersion: string): boolean {
    const target = valid(version);
    const current = valid(currentVersion);
    return target !== null && current !== null && gt(target, current);
}

export function getAvailableAppUpdateVersion(
    state: AppUpdateState,
    currentVersion = APP_VERSION
): string | null {
    const update = state.downloadedUpdate ?? state.availableUpdate;
    if (update) {
        return update.version;
    }

    const latestVersion = state.latestUpdate?.version;
    return latestVersion &&
        state.status !== 'not_available' &&
        isNewerVersion(latestVersion, state.currentVersion ?? currentVersion)
        ? latestVersion
        : null;
}

export function getDownloadableAppUpdate(state: AppUpdateState): AppUpdateInfo | null {
    return (state.status === 'available' || state.status === 'failed') &&
        !state.downloadedUpdate &&
        (state.updateRequirement?.targetSatisfiesRequirement ?? true)
        ? state.availableUpdate
        : null;
}

export function getInstallableAppUpdate(state: AppUpdateState): AppUpdateInfo | null {
    return (state.status === 'downloaded' || state.status === 'failed') &&
        (state.updateRequirement?.targetSatisfiesRequirement ?? true)
        ? state.downloadedUpdate
        : null;
}
