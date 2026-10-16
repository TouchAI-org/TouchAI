/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import { db } from '@database';
import { syncAllModelsMetadata } from '@database/queries/models.ts';
import { setStatistic } from '@database/queries/statistics.ts';
import {
    llmMetadata,
    llmMetadataAliases,
    type NewLlmMetadata,
    type NewLlmMetadataAlias,
    StatisticKey,
} from '@database/schema.ts';

export interface ModelMetadataContents {
    metadataList: NewLlmMetadata[];
    aliasList: NewLlmMetadataAlias[];
}

/**
 * 用给定列表整体替换本地元数据，并同步到运行时模型行。
 *
 * 调用方必须先保证列表非空，否则会清空本地缓存。
 */
export async function replaceModelMetadata(
    { metadataList, aliasList }: ModelMetadataContents,
    { markUpdatedAt }: { markUpdatedAt: boolean }
): Promise<void> {
    await db.transaction(async (tx) => {
        await tx.delete(llmMetadataAliases).run();
        await tx.delete(llmMetadata).run();

        await tx
            .insert(llmMetadata)
            .values(metadataList)
            .onConflictDoNothing({ target: llmMetadata.model_id })
            .run();

        if (aliasList.length > 0) {
            await tx
                .insert(llmMetadataAliases)
                .values(aliasList)
                .onConflictDoNothing({ target: llmMetadataAliases.alias })
                .run();
        }

        await syncAllModelsMetadata(tx);

        if (markUpdatedAt) {
            await setStatistic({
                key: StatisticKey.MODEL_METADATA_LAST_UPDATED_AT,
                value: new Date().toISOString(),
                database: tx,
            });
        }
    });
}
