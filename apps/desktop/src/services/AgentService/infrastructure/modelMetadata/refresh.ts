/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import { db } from '@database';
import { createModels, recordUpstreamModelMetadata } from '@database/queries/models';
import { models } from '@database/schema';
import { eq } from 'drizzle-orm';

import type { ModelInfo } from '../providers/types';
import { syncAllModelsMetadata } from './sync';
import { toUpstreamModelMetadataEntries } from './upstreamEntries';

export interface PersistRefreshedModelsPayload {
    providerId: number;
    models: readonly ModelInfo[];
}

export interface ModelRefreshPersistenceResult {
    /** 本次刷新新增的模型行数。 */
    addedCount: number;
}

/**
 * 一次模型刷新的落库：补出新行 → 记下上游声明 → 让 `syncAllModelsMetadata` 统一重建元数据列。
 *
 * 顺序与事务边界都封装在这里：`syncAllModelsMetadata` 是元数据列的唯一写入方，
 * 调用方不需要知道「先记声明再同步」这一不变量。
 */
export async function persistRefreshedModels({
    providerId,
    models: fetchedModels,
}: PersistRefreshedModelsPayload): Promise<ModelRefreshPersistenceResult> {
    return await db.transaction(async (tx) => {
        const existingRows = await tx
            .select({ modelId: models.model_id })
            .from(models)
            .where(eq(models.provider_id, providerId))
            .all();
        const existingModelIds = new Set(existingRows.map((row) => row.modelId));

        const newModels = fetchedModels
            .filter((fetchedModel) => !existingModelIds.has(fetchedModel.id))
            .map((fetchedModel) => ({
                provider_id: providerId,
                name: fetchedModel.name,
                model_id: fetchedModel.id,
                is_default: 0,
            }));

        if (newModels.length > 0) {
            await createModels(newModels, tx);
        }

        const entries = toUpstreamModelMetadataEntries(fetchedModels);
        if (entries.length > 0) {
            await recordUpstreamModelMetadata({ providerId, entries }, tx);
        }

        await syncAllModelsMetadata(tx);

        return { addedCount: newModels.length };
    });
}
