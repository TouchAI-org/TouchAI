export type NormalizeTauriBundleAssetsOptions = {
    channel: string;
    version: string;
};

export function normalizeTauriBundleAssets(
    projectRoot: string,
    releaseDir: string,
    options: NormalizeTauriBundleAssetsOptions
): Promise<void>;
