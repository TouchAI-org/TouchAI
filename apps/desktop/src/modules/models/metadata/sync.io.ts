import { type MetadataSyncPolicy, synchronizeModelMetadata } from '@database/queries/modelMetadata';
import { expandModelIdCandidates } from '@touchai/models/catalog';

import { resolveModelMetadataRow, selectModelMetadata, toMetadataRecord } from './matching';
export type {
    LlmMetadataRecord,
    ModelMetadataTarget,
    ModelMetadataTargetRow,
    ModelMetadataUpdateRow,
} from './matching';
export { resolveModelMetadataRow, selectModelMetadata } from './matching';

export const modelMetadataPolicy = Object.freeze<MetadataSyncPolicy>({
    candidates(targets) {
        const candidates = new Set<string>();
        for (const target of targets) {
            for (const { candidate } of expandModelIdCandidates(target.modelId))
                candidates.add(candidate);
        }
        return [...candidates];
    },
    resolve({ targets, aliases, records }) {
        const aliasTargets = new Map(aliases.map((row) => [row.alias, row.modelId] as const));
        const metadataByModelId = new Map(
            records.map((row) => [row.modelId, toMetadataRecord(row)] as const)
        );
        const selections = selectModelMetadata(targets, aliasTargets, metadataByModelId);
        const selectedByRowId = new Map(
            selections.map((selection) => [selection.modelRowId, selection.metadata] as const)
        );
        return targets.flatMap((target) => {
            const row = resolveModelMetadataRow(target, selectedByRowId.get(target.id));
            return row ? [row] : [];
        });
    },
});

export function syncAllModelsMetadata(): Promise<void> {
    return synchronizeModelMetadata(modelMetadataPolicy);
}
