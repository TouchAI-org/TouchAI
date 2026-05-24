export function normalizeVelopackReleaseAssets(
    projectRoot: string,
    releaseDir: string,
    options: {
        channel: string;
        version: string;
    }
): Promise<void>;
