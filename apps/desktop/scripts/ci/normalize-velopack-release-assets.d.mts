export type NormalizeVelopackReleaseAssetsOptions = {
    channel: string;
    version: string;
};

export function normalizeVelopackReleaseAssets(
    projectRoot: string,
    releaseDir: string,
    options: NormalizeVelopackReleaseAssetsOptions
): Promise<void>;
