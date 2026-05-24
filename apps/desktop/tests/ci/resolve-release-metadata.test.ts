import { describe, expect, it } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

type ReleaseMetadata = {
    channel: 'stable' | 'beta' | 'nightly';
    version: string;
    tag: string;
    prerelease: 'True' | 'False';
    releaseName: string;
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
            releaseName: 'TouchAI 1.2.3',
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
            releaseName: 'TouchAI Nightly 1.2.4-nightly.20260522.42.3',
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
            releaseName: 'TouchAI Nightly 2.0.1-nightly.20260522.42.1',
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
            releaseName: 'TouchAI Beta 1.3.0-beta.1',
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
        ).toThrow('beta releases must use a beta prerelease version.');
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
