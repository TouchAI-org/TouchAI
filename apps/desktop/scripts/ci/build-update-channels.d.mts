export type BuildUpdateChannelsLatest = {
    version: string;
    tag: string;
    releaseUrl: string;
    publishedAt: string | null;
    prerelease: boolean;
    releaseNotes?: string | null;
    downloads?: Array<{
        kind: 'installer' | 'fullPackage' | 'deltaPackage' | 'updatePackage' | 'asset';
        name: string;
        url: string;
        sizeBytes: number | null;
    }>;
};

export type BuildUpdateChannelsOptions = {
    fetchExisting?: boolean;
    release?: {
        channel: string;
        version: string;
        tag: string;
        publishedAt?: string | null;
        prerelease: boolean;
        releaseNotes?: string | null;
        releaseNotesFile?: string | null;
        releaseDir?: string | null;
        downloads?: BuildUpdateChannelsLatest['downloads'];
    } | null;
    latestByChannel?: Record<string, BuildUpdateChannelsLatest | null>;
};

export function buildUpdateChannels(
    projectRoot: string,
    outputRoot: string,
    now?: Date,
    options?: BuildUpdateChannelsOptions
): Promise<void>;
