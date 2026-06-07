import type { AppUpdateDownload } from './types';

export type AppUpdateRuntimeOs = 'windows' | 'macos' | 'linux' | 'unknown';

export interface AppUpdateRuntimePlatform {
    os: AppUpdateRuntimeOs;
}

function fileName(download: AppUpdateDownload): string {
    return download.name.toLowerCase();
}

function runtimeOsFromNavigator(): AppUpdateRuntimeOs {
    if (typeof navigator === 'undefined') {
        return 'unknown';
    }

    const userAgent = navigator.userAgent.toLowerCase();
    const platform = navigator.platform.toLowerCase();
    const source = `${platform} ${userAgent}`;

    if (source.includes('win')) {
        return 'windows';
    }

    if (source.includes('mac')) {
        return 'macos';
    }

    if (source.includes('linux')) {
        return 'linux';
    }

    return 'unknown';
}

export function currentAppUpdateRuntimePlatform(): AppUpdateRuntimePlatform {
    return {
        os: runtimeOsFromNavigator(),
    };
}

function priorityForWindows(download: AppUpdateDownload): number {
    const name = fileName(download);

    if (name.endsWith('.msi')) {
        return 0;
    }

    if (name.endsWith('-setup.exe')) {
        return 1;
    }

    return 99;
}

function priorityForMacos(download: AppUpdateDownload): number {
    const name = fileName(download);

    if (name.endsWith('.dmg')) {
        return 0;
    }

    if (name.endsWith('.app.tar.gz')) {
        return 1;
    }

    return 99;
}

function priorityForLinux(download: AppUpdateDownload): number {
    const name = fileName(download);

    if (name.endsWith('.appimage')) {
        return 0;
    }

    if (name.endsWith('.deb')) {
        return 1;
    }

    if (name.endsWith('.rpm')) {
        return 2;
    }

    if (name.endsWith('.appimage.tar.gz')) {
        return 3;
    }

    return 99;
}

function priorityForPlatform(
    download: AppUpdateDownload,
    platform: AppUpdateRuntimePlatform
): number {
    switch (platform.os) {
        case 'windows':
            return priorityForWindows(download);
        case 'macos':
            return priorityForMacos(download);
        case 'linux':
            return priorityForLinux(download);
        default:
            return 99;
    }
}

function fallbackPriority(download: AppUpdateDownload): number {
    switch (download.kind) {
        case 'installer':
            return 0;
        case 'updatePackage':
            return 1;
        default:
            return 99;
    }
}

export function preferredAppUpdateDownload(
    downloads: AppUpdateDownload[],
    platform: AppUpdateRuntimePlatform = currentAppUpdateRuntimePlatform()
): AppUpdateDownload | null {
    if (downloads.length === 0) {
        return null;
    }

    const bestForPlatform = downloads
        .map((download, index) => ({
            download,
            index,
            priority: priorityForPlatform(download, platform),
        }))
        .filter((entry) => entry.priority < 99)
        .sort((left, right) => left.priority - right.priority || left.index - right.index)[0];

    if (bestForPlatform) {
        return bestForPlatform.download;
    }

    if (platform.os !== 'unknown') {
        return null;
    }

    return downloads
        .map((download, index) => ({
            download,
            index,
            priority: fallbackPriority(download),
        }))
        .sort((left, right) => left.priority - right.priority || left.index - right.index)[0]!
        .download;
}
