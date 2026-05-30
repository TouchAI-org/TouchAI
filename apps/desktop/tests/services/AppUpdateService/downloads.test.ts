import type { AppUpdateDownload } from '@services/AppUpdateService/types';
import { describe, expect, it } from 'vitest';

import { preferredAppUpdateDownload } from '@/services/AppUpdateService/downloads';

const downloads: AppUpdateDownload[] = [
    {
        kind: 'installer',
        name: 'TouchAI-0.2.0-windows.msi',
        url: 'https://example.com/TouchAI-0.2.0-windows.msi',
        sizeBytes: 1,
    },
    {
        kind: 'installer',
        name: 'TouchAI-0.2.0-macos.dmg',
        url: 'https://example.com/TouchAI-0.2.0-macos.dmg',
        sizeBytes: 1,
    },
    {
        kind: 'installer',
        name: 'TouchAI-0.2.0-linux.AppImage',
        url: 'https://example.com/TouchAI-0.2.0-linux.AppImage',
        sizeBytes: 1,
    },
    {
        kind: 'installer',
        name: 'TouchAI-0.2.0-linux-amd64.deb',
        url: 'https://example.com/TouchAI-0.2.0-linux-amd64.deb',
        sizeBytes: 1,
    },
    {
        kind: 'installer',
        name: 'TouchAI-0.2.0-linux-x86_64.rpm',
        url: 'https://example.com/TouchAI-0.2.0-linux-x86_64.rpm',
        sizeBytes: 1,
    },
];

describe('preferredAppUpdateDownload', () => {
    it('prefers the Windows installer on Windows', () => {
        expect(preferredAppUpdateDownload(downloads, { os: 'windows' })?.name).toBe(
            'TouchAI-0.2.0-windows.msi'
        );
    });

    it('falls back to the Windows setup installer when no MSI is available', () => {
        const downloadsWithoutMsi: AppUpdateDownload[] = [
            {
                kind: 'installer',
                name: 'TouchAI-0.2.0-windows-Setup.exe',
                url: 'https://example.com/TouchAI-0.2.0-windows-Setup.exe',
                sizeBytes: 1,
            },
            {
                kind: 'installer',
                name: 'TouchAI-0.2.0-linux.AppImage',
                url: 'https://example.com/TouchAI-0.2.0-linux.AppImage',
                sizeBytes: 1,
            },
            {
                kind: 'installer',
                name: 'TouchAI-0.2.0-macos.dmg',
                url: 'https://example.com/TouchAI-0.2.0-macos.dmg',
                sizeBytes: 1,
            },
        ];

        expect(preferredAppUpdateDownload(downloadsWithoutMsi, { os: 'windows' })?.name).toBe(
            'TouchAI-0.2.0-windows-Setup.exe'
        );
    });

    it('prefers the DMG on macOS', () => {
        expect(preferredAppUpdateDownload(downloads, { os: 'macos' })?.name).toBe(
            'TouchAI-0.2.0-macos.dmg'
        );
    });

    it('prefers the AppImage on Linux', () => {
        expect(preferredAppUpdateDownload(downloads, { os: 'linux' })?.name).toBe(
            'TouchAI-0.2.0-linux.AppImage'
        );
    });

    it('falls back to the first preferred download on unknown platforms', () => {
        expect(preferredAppUpdateDownload(downloads, { os: 'unknown' })?.name).toBe(
            'TouchAI-0.2.0-windows.msi'
        );
    });

    it('returns null when there are no downloads', () => {
        expect(preferredAppUpdateDownload([], { os: 'windows' })).toBeNull();
    });
});
