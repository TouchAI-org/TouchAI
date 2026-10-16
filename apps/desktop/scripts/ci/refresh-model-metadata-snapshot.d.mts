export type ModelMetadataRefreshStatus = 'updated' | 'unchanged' | 'skipped';

export type ModelMetadataRefreshResult = {
    status: ModelMetadataRefreshStatus;
    targetPath: string;
    models?: number;
    aliases?: number;
    digest?: string;
    reason?: string;
};

export function refreshModelMetadataSnapshot(options?: {
    projectRoot: string;
    sourceUrl?: string;
    fetchImpl?: typeof fetch;
}): Promise<ModelMetadataRefreshResult>;
