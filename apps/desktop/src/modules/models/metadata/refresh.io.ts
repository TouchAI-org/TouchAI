import { persistDiscoveredModels } from '@database/queries/modelMetadata';
import type { ModelInfo } from '@touchai/models/contracts';

import { modelMetadataPolicy } from './sync.io';
import { toUpstreamModelMetadataEntries } from './upstreamEntries.io';

export interface PersistRefreshedModelsPayload {
    providerId: number;
    models: readonly ModelInfo[];
}

export interface ModelRefreshPersistenceResult {
    addedCount: number;
}

export function persistRefreshedModels(
    input: PersistRefreshedModelsPayload
): Promise<ModelRefreshPersistenceResult> {
    return persistDiscoveredModels(
        { ...input, entries: toUpstreamModelMetadataEntries(input.models) },
        modelMetadataPolicy
    );
}
