import { getAvailableAppUpdateVersion } from '@services/AppUpdateService/availability';
import { createInitialAppUpdateState } from '@services/AppUpdateService/state';
import { describe, expect, it } from 'vitest';

function unsupportedState(version: string) {
    return {
        ...createInitialAppUpdateState(),
        status: 'unsupported' as const,
        latestUpdate: {
            version,
            tag: `v${version}`,
            releaseUrl: 'https://example.com/releases',
            publishedAt: null,
            prerelease: version.includes('-'),
            releaseNotes: null,
            downloads: [],
        },
    };
}

describe('getAvailableAppUpdateVersion', () => {
    it.each([
        ['1.2.3', '1.2.2', '1.2.3'],
        ['1.2.2', '1.2.2', null],
        ['1.2.1', '1.2.2', null],
        ['1.2.2-beta.2', '1.2.2', null],
        ['1.2.2', '1.2.2-beta.2', '1.2.2'],
        ['1.2.2-beta.10', '1.2.2-beta.9', '1.2.2-beta.10'],
        ['1.2.2-beta.1', '1.2.2-beta.1.1', null],
        ['1.2.2+build.2', '1.2.2+build.1', null],
    ])('compares feed version %s with current version %s', (version, current, expected) => {
        expect(getAvailableAppUpdateVersion(unsupportedState(version), current)).toBe(expected);
    });

    it('retains the available version while a background check is running', () => {
        expect(
            getAvailableAppUpdateVersion({
                ...createInitialAppUpdateState(),
                status: 'checking',
                availableUpdate: {
                    version: '1.2.3',
                    fileName: 'update.nupkg',
                    notes: null,
                    sizeBytes: null,
                },
            })
        ).toBe('1.2.3');
    });

    it('does not advertise an update when the updater reports none is available', () => {
        expect(
            getAvailableAppUpdateVersion(
                {
                    ...unsupportedState('1.2.3'),
                    status: 'not_available',
                },
                '1.2.2'
            )
        ).toBeNull();
    });
});
