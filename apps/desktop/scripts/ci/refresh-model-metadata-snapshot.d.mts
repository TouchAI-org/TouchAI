export type ModelMetadataRefreshStatus = 'updated' | 'unchanged' | 'skipped';

export type ModelMetadataRefreshResult = {
    status: ModelMetadataRefreshStatus;
    targetPath: string;
    providers?: number;
    models?: number;
    digest?: string;
    reason?: string;
};

export function refreshModelMetadataSnapshot(options?: {
    projectRoot: string;
    sourceUrl?: string;
    fetchImpl?: typeof fetch;
}): Promise<ModelMetadataRefreshResult>;
