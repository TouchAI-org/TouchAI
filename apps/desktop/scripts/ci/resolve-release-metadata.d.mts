export type ReleaseChannel = 'stable' | 'beta' | 'nightly';

export function resolveReleaseMetadata(input: {
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
    productConfig: {
        displayName: string;
        services?: {
            updates?: {
                channels?: Record<string, { displayName?: string }>;
            };
        };
    };
}): {
    channel: ReleaseChannel;
    version: string;
    tag: string;
    prerelease: 'True' | 'False';
    releaseName: string;
};
