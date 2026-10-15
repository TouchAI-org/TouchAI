export const MODEL_METADATA_SOURCE_URL: string;

export const MODEL_METADATA_SNAPSHOT_PATH: string;

export type TrimmedModelMetadataCatalog = Record<
    string,
    {
        models: Record<string, Record<string, unknown>>;
    }
>;

export function trimCatalog(rawCatalog: unknown): TrimmedModelMetadataCatalog;

export function countCatalog(catalog: TrimmedModelMetadataCatalog): {
    providers: number;
    models: number;
};

export function assertCatalogFloor(catalog: TrimmedModelMetadataCatalog): {
    providers: number;
    models: number;
};

export function updateModelMetadataSnapshot(options?: {
    projectRoot: string;
    sourceUrl?: string;
    fetchImpl?: typeof fetch;
}): Promise<{
    targetPath: string;
    providers: number;
    models: number;
}>;
