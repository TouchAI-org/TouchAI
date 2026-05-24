export type BuildUpdateChannelsLatest = {
    version: string;
    tag: string;
    releaseUrl: string;
    publishedAt: string | null;
    prerelease: boolean;
};

export type BuildUpdateChannelsOptions = {
    githubRepository?: string | null;
    githubToken?: string | null;
    release?: {
        channel: string;
        version: string;
        tag: string;
        publishedAt?: string | null;
        prerelease: boolean;
    } | null;
    latestByChannel?: Record<string, BuildUpdateChannelsLatest | null>;
};

export function buildUpdateChannels(
    projectRoot: string,
    outputRoot: string,
    now?: Date,
    options?: BuildUpdateChannelsOptions
): Promise<void>;
