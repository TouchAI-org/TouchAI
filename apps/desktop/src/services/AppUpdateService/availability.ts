import { APP_VERSION } from '@/config/product';

import type { AppUpdateState } from './types';

function isNewerVersion(version: string, currentVersion: string): boolean {
    const pattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/;
    const target = pattern.exec(version);
    const current = pattern.exec(currentVersion);
    if (!target || !current) {
        return false;
    }

    for (let index = 1; index <= 3; index += 1) {
        const difference = Number(target[index]) - Number(current[index]);
        if (difference !== 0) {
            return difference > 0;
        }
    }

    if (!target[4] || !current[4]) {
        return Boolean(current[4] && !target[4]);
    }

    const targetPrerelease = target[4].split('.');
    const currentPrerelease = current[4].split('.');
    for (
        let index = 0;
        index < Math.max(targetPrerelease.length, currentPrerelease.length);
        index += 1
    ) {
        const left = targetPrerelease[index];
        const right = currentPrerelease[index];
        if (left === undefined || right === undefined) {
            return right === undefined;
        }
        if (left === right) {
            continue;
        }

        const leftNumeric = /^\d+$/.test(left);
        const rightNumeric = /^\d+$/.test(right);
        if (leftNumeric && rightNumeric) {
            return Number(left) > Number(right);
        }
        if (leftNumeric !== rightNumeric) {
            return rightNumeric;
        }
        return left > right;
    }

    return false;
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
