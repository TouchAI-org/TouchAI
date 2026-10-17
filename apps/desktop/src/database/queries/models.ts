// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { and, desc, eq, sql } from 'drizzle-orm';

import { tt } from '@/i18n';

import { type DatabaseExecutor, db } from '../index';
import { models, providers } from '../schema';
import type {
    ApplyUpstreamModelMetadataPayload,
    FindModelsWithProviderPayload,
    ModelCreateData,
    ModelEntity,
    ModelUpdateData,
    ModelWithProvider,
    ProviderModelLookupPayload,
} from '../types';

export type { ModelWithProvider } from '../types';

export const modelWithProviderSelection = {
    id: models.id,
    created_at: models.created_at,
    updated_at: models.updated_at,
    provider_id: models.provider_id,
    model_id: models.model_id,
    name: models.name,
    is_default: models.is_default,
    last_used_at: models.last_used_at,
    attachment: models.attachment,
    modalities: models.modalities,
    open_weights: models.open_weights,
    reasoning: models.reasoning,
    reasoning_options: models.reasoning_options,
    release_date: models.release_date,
    temperature: models.temperature,
    tool_call: models.tool_call,
    knowledge: models.knowledge,
    context_limit: models.context_limit,
    output_limit: models.output_limit,
    is_custom_metadata: models.is_custom_metadata,
    upstream_metadata: models.upstream_metadata,
    provider_name: sql<string>`${providers.name}`.as('provider_name'),
    provider_driver: sql<ModelWithProvider['provider_driver']>`${providers.driver}`.as(
        'provider_driver'
    ),
    api_endpoint: sql<string>`${providers.api_endpoint}`.as('api_endpoint'),
    api_key: sql<string | null>`${providers.api_key}`.as('api_key'),
    provider_config_json: sql<string | null>`${providers.config_json}`.as('provider_config_json'),
    provider_enabled: sql<number>`${providers.enabled}`.as('provider_enabled'),
    provider_logo: sql<string>`${providers.logo}`.as('provider_logo'),
};

/**
 * 查找全局默认模型。
 */
export const findDefaultModel = async (): Promise<ModelEntity | undefined> =>
    await db.select().from(models).where(eq(models.is_default, 1)).get();

/**
 * 查找默认模型且服务商已启用（包含服务商信息）。
 */
export const findDefaultModelWithProvider = async (): Promise<ModelWithProvider | null> => {
    const result = await db
        .select(modelWithProviderSelection)
        .from(models)
        .innerJoin(providers, eq(providers.id, models.provider_id))
        .where(and(eq(models.is_default, 1), eq(providers.enabled, 1)))
        .orderBy(models.id)
        .limit(1)
        .get();

    if (!result || result.id === undefined) {
        return null;
    }

    return result as ModelWithProvider;
};

/**
 * 查找模型并关联服务商信息。
 */
export const findModelsWithProvider = async (
    payload: FindModelsWithProviderPayload = {}
): Promise<ModelWithProvider[]> => {
    const { providerId } = payload;
    const query = db
        .select(modelWithProviderSelection)
        .from(models)
        .innerJoin(providers, eq(providers.id, models.provider_id));

    if (providerId !== undefined) {
        return (await query
            .where(eq(models.provider_id, providerId))
            .orderBy(desc(models.is_default), models.id)
            .all()) as ModelWithProvider[];
    }

    return (await query.orderBy(desc(models.is_default), models.id).all()) as ModelWithProvider[];
};

/**
 * 创建模型。
 */
export const createModel = async (
    modelDraft: ModelCreateData,
    database: DatabaseExecutor = db
): Promise<ModelEntity> => {
    const createdModel = await database.insert(models).values(modelDraft).returning().get();

    if (!createdModel || createdModel.id === undefined) {
        throw new Error('Failed to create model');
    }

    return createdModel;
};

/**
 * 批量创建模型。
 */
export const createModels = async (
    modelList: ModelCreateData[],
    database: DatabaseExecutor = db
): Promise<void> => {
    if (modelList.length === 0) {
        return;
    }

    await database.insert(models).values(modelList).run();
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
    await db.update(models).set(modelPatch).where(eq(models.id, id)).run();
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
    await db.transaction(async (tx) => {
        const modelWithProvider = await tx
            .select({
                id: models.id,
                enabled: providers.enabled,
                provider_name: providers.name,
            })
            .from(models)
            .innerJoin(providers, eq(providers.id, models.provider_id))
            .where(eq(models.id, modelId))
            .get();

        if (!modelWithProvider) {
            throw new Error(tt('模型不存在'));
        }

        if (modelWithProvider.enabled === 0) {
            throw new Error(
                tt('无法设置默认模型：服务商 "{provider}" 未启用', {
                    provider: modelWithProvider.provider_name,
                })
            );
        }

        await tx.update(models).set({ is_default: 0 }).where(eq(models.is_default, 1)).run();

        await tx.update(models).set({ is_default: 1 }).where(eq(models.id, modelId)).run();
    });
};

/**
 * 删除模型。
 */
export const deleteModel = async ({ id }: { id: number }): Promise<boolean> => {
    await db.delete(models).where(eq(models.id, id)).run();
    return true;
};

/**
 * 根据 provider_id 和 model_id 查找模型（包含服务商信息）。
 */
export const findModelByProviderAndModelId = async ({
    providerId,
    modelId,
}: ProviderModelLookupPayload): Promise<ModelWithProvider | undefined> =>
    (await db
        .select(modelWithProviderSelection)
        .from(models)
        .innerJoin(providers, eq(providers.id, models.provider_id))
        .where(and(eq(models.provider_id, providerId), eq(models.model_id, modelId)))
        .get()) as ModelWithProvider | undefined;

/**
 * 用上游 `/v1/models` 自己声明的能力覆盖 models.dev 兜底值。
 *
 * 只写 `is_custom_metadata = 0` 且属于该 provider 的行，只覆盖上游声明过的字段。
 * 声明同时记入 `upstream_metadata`，让后续 `syncAllModelsMetadata` 在重启、刷新后
 * 仍按「上游 > 兜底」优先级重建这些列，所以调用顺序必须是先 sync 再 overlay。
 * 上游显式声明 `reasoning: false` 时，旧档位一并清空。
 */
export const applyUpstreamModelMetadata = async (
    { providerId, entries }: ApplyUpstreamModelMetadataPayload,
    database: DatabaseExecutor = db
): Promise<void> => {
    if (entries.length === 0) {
        return;
    }

    const payload = JSON.stringify(entries);
    const updateSql = sql`
        WITH upstream_model_metadata AS (
            SELECT
                json_extract(entry.value, '$.model_id') AS model_id,
                json_extract(entry.value, '$.metadata') AS metadata,
                json_extract(entry.value, '$.metadata.context_limit') AS context_limit,
                json_extract(entry.value, '$.metadata.output_limit') AS output_limit,
                json_extract(entry.value, '$.metadata.modalities') AS modalities,
                json_extract(entry.value, '$.metadata.attachment') AS attachment,
                json_extract(entry.value, '$.metadata.reasoning') AS reasoning,
                json_extract(entry.value, '$.metadata.reasoning_options') AS reasoning_options,
                json_extract(entry.value, '$.metadata.tool_call') AS tool_call
            FROM json_each(${payload}) AS entry
        )
        UPDATE models
        SET
            upstream_metadata = json_patch(
                COALESCE(upstream_metadata, '{}'),
                COALESCE((
                    SELECT upstream_model_metadata.metadata
                    FROM upstream_model_metadata
                    WHERE upstream_model_metadata.model_id = models.model_id
                ), '{}')
            ),
            context_limit = COALESCE((
                SELECT upstream_model_metadata.context_limit
                FROM upstream_model_metadata
                WHERE upstream_model_metadata.model_id = models.model_id
            ), context_limit),
            output_limit = COALESCE((
                SELECT upstream_model_metadata.output_limit
                FROM upstream_model_metadata
                WHERE upstream_model_metadata.model_id = models.model_id
            ), output_limit),
            modalities = COALESCE((
                SELECT upstream_model_metadata.modalities
                FROM upstream_model_metadata
                WHERE upstream_model_metadata.model_id = models.model_id
            ), modalities),
            attachment = COALESCE((
                SELECT upstream_model_metadata.attachment
                FROM upstream_model_metadata
                WHERE upstream_model_metadata.model_id = models.model_id
            ), attachment),
            reasoning = COALESCE((
                SELECT upstream_model_metadata.reasoning
                FROM upstream_model_metadata
                WHERE upstream_model_metadata.model_id = models.model_id
            ), reasoning),
            reasoning_options = CASE
                WHEN (
                    SELECT upstream_model_metadata.reasoning
                    FROM upstream_model_metadata
                    WHERE upstream_model_metadata.model_id = models.model_id
                ) = 0 THEN NULL
                ELSE COALESCE((
                    SELECT upstream_model_metadata.reasoning_options
                    FROM upstream_model_metadata
                    WHERE upstream_model_metadata.model_id = models.model_id
                ), reasoning_options)
            END,
            tool_call = COALESCE((
                SELECT upstream_model_metadata.tool_call
                FROM upstream_model_metadata
                WHERE upstream_model_metadata.model_id = models.model_id
            ), tool_call),
            updated_at = datetime('now')
        WHERE provider_id = ${providerId}
          AND is_custom_metadata = 0
          AND EXISTS (
            SELECT 1
            FROM upstream_model_metadata
            WHERE upstream_model_metadata.model_id = models.model_id
          )
    `;

    await database.run(updateSql);
};
