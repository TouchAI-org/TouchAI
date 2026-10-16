export const MODEL_METADATA_SOURCE_URL: string;

export const MODEL_METADATA_SNAPSHOT_PATH: string;

export type ModelMetadataCatalog = {
    models: Record<string, Record<string, unknown>>;
    alias: Record<string, string>;
};

export function buildCatalog(rawCatalog: unknown): ModelMetadataCatalog;

export function countCatalog(catalog: ModelMetadataCatalog): {
    models: number;
    aliases: number;
};

export function assertCatalogFloor(catalog: ModelMetadataCatalog): {
    models: number;
    aliases: number;
};

export function updateModelMetadataSnapshot(options?: {
    projectRoot: string;
    sourceUrl?: string;
    fetchImpl?: typeof fetch;
}): Promise<{
    targetPath: string;
    models: number;
    aliases: number;
}>;
