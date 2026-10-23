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

describe('user is offered the newest release version', () => {
    it.each([
        ['1.2.3', '1.2.2', '1.2.3'],
        ['1.2.2', '1.2.2', null],
        ['1.2.1', '1.2.2', null],
        ['1.2.2-beta.2', '1.2.2', null],
        ['1.2.2', '1.2.2-beta.2', '1.2.2'],
        ['1.2.2-beta.10', '1.2.2-beta.9', '1.2.2-beta.10'],
        ['1.2.2-beta.1', '1.2.2-beta.1.1', null],
        ['1.2.2+build.2', '1.2.2+build.1', null],
    ])(
        'user is offered %s only when it is newer than the installed %s',
        (version, current, expected) => {
            expect(getAvailableAppUpdateVersion(unsupportedState(version), current)).toBe(expected);
        }
    );

    it('user keeps seeing the known update while a background check runs', () => {
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

    it('user is not offered an update when the updater reports none', () => {
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
