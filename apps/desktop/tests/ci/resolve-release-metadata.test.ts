import { describe, expect, it } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

type ReleaseMetadata = {
    channel: 'stable' | 'beta' | 'nightly';
    version: string;
    tag: string;
    prerelease: 'True' | 'False';
    releaseName: string;
    shouldPublish: boolean;
    skipReason: string | null;
};

type ResolveReleaseMetadata = (input: {
    eventName: string;
    refType?: string | null;
    refName?: string | null;
    inputChannel?: string | null;
    inputVersion?: string | null;
    packageVersion: string;
    stableBaseVersion?: string | null;
    projectRoot?: string | null;
    runNumber?: string | number;
    runAttempt?: string | number;
    date?: Date;
    productConfig?: typeof APP_PRODUCT_CONFIG;
    targetCommit?: string | null;
    latestNightly?: {
        tag: string;
        commit: string;
    } | null;
    git?: (args: string[]) => string;
}) => ReleaseMetadata;

async function loadResolver(): Promise<ResolveReleaseMetadata | undefined> {
    try {
        const module = await import('../../scripts/ci/resolve-release-metadata.mjs');
        return module.resolveReleaseMetadata as ResolveReleaseMetadata;
    } catch {
        return undefined;
    }
}

function releaseInput(input: Parameters<ResolveReleaseMetadata>[0]) {
    return {
        ...input,
        productConfig: APP_PRODUCT_CONFIG,
    };
}

describe('resolveReleaseMetadata', () => {
    it('uses stable for official semver tags', async () => {
        const resolveReleaseMetadata = await loadResolver();

        expect(resolveReleaseMetadata).toBeTypeOf('function');
        expect(
            resolveReleaseMetadata?.(
                releaseInput({
                    eventName: 'push',
                    refType: 'tag',
                    refName: 'v1.2.3',
                    packageVersion: '1.2.3',
                })
            )
        ).toEqual({
            channel: 'stable',
            version: '1.2.3',
            tag: 'v1.2.3',
            prerelease: 'False',
            releaseName: 'TouchAI v1.2.3',
            shouldPublish: true,
            skipReason: null,
        });
    });

    it('uses beta for prerelease semver tags', async () => {
        const resolveReleaseMetadata = await loadResolver();

        expect(resolveReleaseMetadata).toBeTypeOf('function');
        expect(
            resolveReleaseMetadata?.(
                releaseInput({
                    eventName: 'push',
                    refType: 'tag',
                    refName: 'v1.2.3-beta.2',
                    packageVersion: '1.2.3-beta.2',
                })
            )
        ).toMatchObject({
            channel: 'beta',
            version: '1.2.3-beta.2',
            tag: 'v1.2.3-beta.2',
            prerelease: 'True',
        });
    });

    it('generates deterministic nightly versions for scheduled runs', async () => {
        const resolveReleaseMetadata = await loadResolver();

        expect(resolveReleaseMetadata).toBeTypeOf('function');
        expect(
            resolveReleaseMetadata?.(
                releaseInput({
                    eventName: 'schedule',
                    packageVersion: '1.2.3',
                    runNumber: 42,
                    runAttempt: 3,
                    date: new Date('2026-05-22T18:00:00Z'),
                })
            )
        ).toEqual({
            channel: 'nightly',
            version: '1.2.4-nightly.20260522.42.3',
            tag: 'v1.2.4-nightly.20260522.42.3',
            prerelease: 'True',
            releaseName: 'TouchAI v1.2.4-nightly.20260522.42.3',
            shouldPublish: true,
            skipReason: null,
        });
    });

    it('skips scheduled nightly when the latest nightly already points at the target commit', async () => {
        const resolveReleaseMetadata = await loadResolver();

        expect(resolveReleaseMetadata).toBeTypeOf('function');
        expect(
            resolveReleaseMetadata?.(
                releaseInput({
                    eventName: 'schedule',
                    packageVersion: '1.2.3',
                    runNumber: 42,
                    runAttempt: 3,
                    date: new Date('2026-05-22T18:00:00Z'),
                    targetCommit: 'abc123',
                    latestNightly: {
                        tag: 'v1.2.1-nightly.20260705.75.1',
                        commit: 'abc123',
                    },
                })
            )
        ).toMatchObject({
            channel: 'nightly',
            shouldPublish: false,
            skipReason: 'Latest nightly v1.2.1-nightly.20260705.75.1 already points at abc123.',
        });
    });

    it('keeps manual nightly dispatches publishable even when the commit is unchanged', async () => {
        const resolveReleaseMetadata = await loadResolver();

        expect(resolveReleaseMetadata).toBeTypeOf('function');
        expect(
            resolveReleaseMetadata?.(
                releaseInput({
                    eventName: 'workflow_dispatch',
                    inputChannel: 'nightly',
                    inputVersion: '1.2.3-nightly.1',
                    packageVersion: '1.2.3',
                    targetCommit: 'abc123',
                    latestNightly: {
                        tag: 'v1.2.1-nightly.20260705.75.1',
                        commit: 'abc123',
                    },
                })
            )
        ).toMatchObject({
            channel: 'nightly',
            shouldPublish: true,
            skipReason: null,
        });
    });

    it('reads the latest nightly tag from git when no override is provided', async () => {
        const resolveReleaseMetadata = await loadResolver();
        const gitResponses = new Map([
            [
                'tag --list v*-nightly.*',
                [
                    'v1.2.1-nightly.20260618.58.1',
                    'v1.2.1-nightly.20260629.69.1',
                    'v1.2.1-nightly.20260605.42.1',
                ].join('\n'),
            ],
            ['rev-list -n 1 v1.2.1-nightly.20260629.69.1', 'head456'],
        ]);

        expect(resolveReleaseMetadata).toBeTypeOf('function');
        expect(
            resolveReleaseMetadata?.(
                releaseInput({
                    eventName: 'schedule',
                    packageVersion: '1.2.3',
                    runNumber: 42,
                    runAttempt: 3,
                    date: new Date('2026-05-22T18:00:00Z'),
                    targetCommit: 'head456',
                    git: (args) => gitResponses.get(args.join(' ')) ?? '',
                })
            )
        ).toMatchObject({
            shouldPublish: false,
            skipReason: 'Latest nightly v1.2.1-nightly.20260629.69.1 already points at head456.',
        });
    });

    it('publishes scheduled nightly when no prior nightly tag exists', async () => {
        const resolveReleaseMetadata = await loadResolver();

        expect(resolveReleaseMetadata).toBeTypeOf('function');
        expect(
            resolveReleaseMetadata?.(
                releaseInput({
                    eventName: 'schedule',
                    packageVersion: '1.2.3',
                    runNumber: 42,
                    runAttempt: 3,
                    date: new Date('2026-05-22T18:00:00Z'),
                    targetCommit: 'abc123',
                    git: () => '',
                })
            )
        ).toMatchObject({
            shouldPublish: true,
            skipReason: null,
        });
    });

    it('uses the latest stable base when generating nightly versions', async () => {
        const resolveReleaseMetadata = await loadResolver();

        expect(resolveReleaseMetadata).toBeTypeOf('function');
        expect(
            resolveReleaseMetadata?.(
                releaseInput({
                    eventName: 'schedule',
                    packageVersion: '1.2.3',
                    stableBaseVersion: '2.0.0',
                    runNumber: 42,
                    runAttempt: 1,
                    date: new Date('2026-05-22T18:00:00Z'),
                })
            )
        ).toEqual({
            channel: 'nightly',
            version: '2.0.1-nightly.20260522.42.1',
            tag: 'v2.0.1-nightly.20260522.42.1',
            prerelease: 'True',
            releaseName: 'TouchAI v2.0.1-nightly.20260522.42.1',
            shouldPublish: true,
            skipReason: null,
        });
    });

    it('uses the injected git implementation when reading the latest stable base', async () => {
        const resolveReleaseMetadata = await loadResolver();
        const gitResponses = new Map([
            ['tag --list v*-nightly.*', ''],
            ['tag --list v*', ['v1.9.0', 'v2.0.0', 'v2.0.0-beta.1'].join('\n')],
        ]);

        expect(resolveReleaseMetadata).toBeTypeOf('function');
        expect(
            resolveReleaseMetadata?.(
                releaseInput({
                    eventName: 'schedule',
                    packageVersion: '1.2.3',
                    projectRoot: 'repo',
                    runNumber: 42,
                    runAttempt: 1,
                    date: new Date('2026-05-22T18:00:00Z'),
                    targetCommit: 'abc123',
                    git: (args) => gitResponses.get(args.join(' ')) ?? '',
                })
            )
        ).toMatchObject({
            version: '2.0.1-nightly.20260522.42.1',
            shouldPublish: true,
            skipReason: null,
        });
    });

    it('requires exact versions for manual beta runs', async () => {
        const resolveReleaseMetadata = await loadResolver();

        expect(resolveReleaseMetadata).toBeTypeOf('function');
        expect(() =>
            resolveReleaseMetadata?.(
                releaseInput({
                    eventName: 'workflow_dispatch',
                    inputChannel: 'beta',
                    packageVersion: '1.2.3',
                    runNumber: 42,
                    runAttempt: 1,
                })
            )
        ).toThrow('beta releases require an exact semantic version.');
    });

    it('accepts exact manual beta versions', async () => {
        const resolveReleaseMetadata = await loadResolver();

        expect(resolveReleaseMetadata).toBeTypeOf('function');
        expect(
            resolveReleaseMetadata?.(
                releaseInput({
                    eventName: 'workflow_dispatch',
                    inputChannel: 'beta',
                    inputVersion: '1.3.0-beta.1',
                    packageVersion: '1.2.3',
                    runNumber: 42,
                    runAttempt: 1,
                })
            )
        ).toEqual({
            channel: 'beta',
            version: '1.3.0-beta.1',
            tag: 'v1.3.0-beta.1',
            prerelease: 'True',
            releaseName: 'TouchAI v1.3.0-beta.1',
            shouldPublish: true,
            skipReason: null,
        });
    });

    it('rejects mismatched channel and prerelease versions', async () => {
        const resolveReleaseMetadata = await loadResolver();

        expect(resolveReleaseMetadata).toBeTypeOf('function');
        expect(() =>
            resolveReleaseMetadata?.(
                releaseInput({
                    eventName: 'workflow_dispatch',
                    inputChannel: 'beta',
                    inputVersion: '1.2.3-nightly.1',
                    packageVersion: '1.2.3',
                })
            )
        ).toThrow('Beta releases must use a beta prerelease version.');
    });

    it('rejects manual stable releases because release-please owns stable', async () => {
        const resolveReleaseMetadata = await loadResolver();

        expect(resolveReleaseMetadata).toBeTypeOf('function');
        expect(() =>
            resolveReleaseMetadata?.(
                releaseInput({
                    eventName: 'workflow_dispatch',
                    inputChannel: 'stable',
                    inputVersion: '1.2.3',
                    packageVersion: '1.2.2',
                })
            )
        ).toThrow('Stable releases are managed by release-please.');
    });
});
