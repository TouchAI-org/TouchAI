/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import { native } from '@services/NativeService';

import type { ModelInfo } from '../providers/types';
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
    return native.database.operation<ModelRefreshPersistenceResult>({
        kind: 'model_persist_catalog',
        providerId,
        models: fetchedModels.map((model) => ({
            model_id: model.id,
            name: model.name,
        })),
        entries: toUpstreamModelMetadataEntries(fetchedModels).map((entry) => ({
            model_id: entry.model_id,
            metadata: { ...entry.metadata },
        })),
    });
}
