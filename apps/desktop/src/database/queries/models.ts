// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import { tt } from '@/i18n';

import type {
    FindModelsWithProviderPayload,
    ModelCreateData,
    ModelEntity,
    ModelUpdateData,
    ModelWithProvider,
    ProviderModelLookupPayload,
    RecordUpstreamModelMetadataPayload,
} from '../types';

export type { ModelWithProvider } from '../types';

/**
 * 查找全局默认模型。
 */
export const findDefaultModel = async (): Promise<ModelEntity | undefined> =>
    (await native.database.operation<ModelEntity | null>({ kind: 'model_find_default' })) ??
    undefined;

/**
 * 查找默认模型且服务商已启用（包含服务商信息）。
 */
export const findDefaultModelWithProvider = async (): Promise<ModelWithProvider | null> =>
    native.database.operation<ModelWithProvider | null>({
        kind: 'model_find_default_with_provider',
    });

/**
 * 查找模型并关联服务商信息。
 */
export const findModelsWithProvider = async (
    payload: FindModelsWithProviderPayload = {}
): Promise<ModelWithProvider[]> =>
    native.database.operation<ModelWithProvider[]>({
        kind: 'model_list_with_provider',
        providerId: payload.providerId,
    });

/**
 * 创建模型。
 */
export const createModel = async (modelDraft: ModelCreateData): Promise<ModelEntity> => {
    const createdModel = await native.database.operation<ModelEntity | null>({
        kind: 'model_create',
        data: { ...modelDraft },
    });

    if (!createdModel) {
        throw new Error('Failed to create model');
    }

    return createdModel;
};

/**
 * 更新模型。
 */
export const updateModel = async ({
    id,
    modelPatch,
}: {
    id: number;
    modelPatch: ModelUpdateData;
}): Promise<void> => {
    await native.database.operation({
        kind: 'model_update',
        id,
        data: { ...modelPatch },
    });
};

/**
 * 更新模型最后使用时间。
 */
export const updateModelLastUsed = async ({ id }: { id: number }): Promise<void> =>
    updateModel({ id, modelPatch: { last_used_at: new Date().toISOString() } });

/**
 * 设置全局默认模型，并清除其他模型的默认标记。
 */
export const setDefaultModel = async ({ modelId }: { modelId: number }): Promise<void> => {
    try {
        await native.database.operation({ kind: 'model_set_default', modelId });
    } catch (error) {
        const code =
            error && typeof error === 'object' && 'code' in error
                ? String((error as { code?: unknown }).code)
                : '';
        if (code === 'model-not-found') {
            throw Object.assign(new Error(tt('模型不存在')), { cause: error });
        }
        if (code === 'provider-disabled') {
            throw Object.assign(new Error(tt('无法设置默认模型：服务商未启用')), {
                cause: error,
            });
        }
        throw error;
    }
};

/**
 * 删除模型。
 */
export const deleteModel = async ({ id }: { id: number }): Promise<boolean> =>
    native.database.operation<boolean>({ kind: 'model_delete', id });

/**
 * 根据 provider_id 和 model_id 查找模型（包含服务商信息）。
 */
export const findModelByProviderAndModelId = async ({
    providerId,
    modelId,
}: ProviderModelLookupPayload): Promise<ModelWithProvider | undefined> =>
    (await native.database.operation<ModelWithProvider | null>({
        kind: 'model_find_by_provider_and_model_id',
        providerId,
        modelId,
    })) ?? undefined;

/**
 * 记下上游 `/v1/models` 声明的能力，交给 `syncAllModelsMetadata` 按
 * 「上游 > models.dev > 已有值」统一重建模型列。
 */
export const recordUpstreamModelMetadata = async ({
    providerId,
    entries,
}: RecordUpstreamModelMetadataPayload): Promise<void> => {
    if (entries.length === 0) {
        return;
    }
    await native.database.operation({
        kind: 'model_record_upstream_metadata',
        providerId,
        entries: entries.map((entry) => ({
            model_id: entry.model_id,
            metadata: { ...entry.metadata },
        })),
    });
};
