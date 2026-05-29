export type PlanR2ReleaseAssetPruneOptions = {
    fetch?: typeof fetch;
    token?: string | null;
};

export function planR2ReleaseAssetPrune(
    projectRoot: string,
    channel: string,
    options?: PlanR2ReleaseAssetPruneOptions
): Promise<string[]>;
