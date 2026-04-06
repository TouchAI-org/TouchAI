// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { and, desc, eq, or, sql } from 'drizzle-orm';

import { type DatabaseExecutor, db } from '../index';
import { models, providers } from '../schema';
import type {
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
    release_date: models.release_date,
    temperature: models.temperature,
    tool_call: models.tool_call,
    knowledge: models.knowledge,
    context_limit: models.context_limit,
    output_limit: models.output_limit,
    is_custom_metadata: models.is_custom_metadata,
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
            throw new Error('模型不存在');
        }

        if (modelWithProvider.enabled === 0) {
            throw new Error(`无法设置默认模型：服务商 "${modelWithProvider.provider_name}" 未启用`);
        }

        await tx
            .update(models)
            .set({
                is_default: sql<number>`case when ${models.id} = ${modelId} then 1 else 0 end`,
            })
            .where(or(eq(models.is_default, 1), eq(models.id, modelId)))
            .run();
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
 * 批量同步所有模型的元数据。
 */
export const syncAllModelsMetadata = async (database: DatabaseExecutor = db): Promise<void> => {
    const updateSql = sql.raw(`
        UPDATE models
        SET
            attachment = COALESCE((
                SELECT m2.attachment
                FROM llm_metadata AS m2
                WHERE lower(m2.model_id) LIKE '%' || lower(models.model_id) || '%'
                ORDER BY
                    (m2.attachment + m2.open_weights + m2.reasoning + m2.temperature + m2.tool_call +
                        CASE WHEN m2.modalities IS NOT NULL AND m2.modalities <> '' THEN 1 ELSE 0 END
                    ) DESC,
                    length(m2.model_id) DESC
                LIMIT 1
            ), attachment),
            modalities = COALESCE((
                SELECT m2.modalities
                FROM llm_metadata AS m2
                WHERE lower(m2.model_id) LIKE '%' || lower(models.model_id) || '%'
                ORDER BY
                    (m2.attachment + m2.open_weights + m2.reasoning + m2.temperature + m2.tool_call +
                        CASE WHEN m2.modalities IS NOT NULL AND m2.modalities <> '' THEN 1 ELSE 0 END
                    ) DESC,
                    length(m2.model_id) DESC
                LIMIT 1
            ), modalities),
            open_weights = COALESCE((
                SELECT m2.open_weights
                FROM llm_metadata AS m2
                WHERE lower(m2.model_id) LIKE '%' || lower(models.model_id) || '%'
                ORDER BY
                    (m2.attachment + m2.open_weights + m2.reasoning + m2.temperature + m2.tool_call +
                        CASE WHEN m2.modalities IS NOT NULL AND m2.modalities <> '' THEN 1 ELSE 0 END
                    ) DESC,
                    length(m2.model_id) DESC
                LIMIT 1
            ), open_weights),
            reasoning = COALESCE((
                SELECT m2.reasoning
                FROM llm_metadata AS m2
                WHERE lower(m2.model_id) LIKE '%' || lower(models.model_id) || '%'
                ORDER BY
                    (m2.attachment + m2.open_weights + m2.reasoning + m2.temperature + m2.tool_call +
                        CASE WHEN m2.modalities IS NOT NULL AND m2.modalities <> '' THEN 1 ELSE 0 END
                    ) DESC,
                    length(m2.model_id) DESC
                LIMIT 1
            ), reasoning),
            release_date = COALESCE((
                SELECT m2.release_date
                FROM llm_metadata AS m2
                WHERE lower(m2.model_id) LIKE '%' || lower(models.model_id) || '%'
                ORDER BY
                    (m2.attachment + m2.open_weights + m2.reasoning + m2.temperature + m2.tool_call +
                        CASE WHEN m2.modalities IS NOT NULL AND m2.modalities <> '' THEN 1 ELSE 0 END
                    ) DESC,
                    length(m2.model_id) DESC
                LIMIT 1
            ), release_date),
            temperature = COALESCE((
                SELECT m2.temperature
                FROM llm_metadata AS m2
                WHERE lower(m2.model_id) LIKE '%' || lower(models.model_id) || '%'
                ORDER BY
                    (m2.attachment + m2.open_weights + m2.reasoning + m2.temperature + m2.tool_call +
                        CASE WHEN m2.modalities IS NOT NULL AND m2.modalities <> '' THEN 1 ELSE 0 END
                    ) DESC,
                    length(m2.model_id) DESC
                LIMIT 1
            ), temperature),
            tool_call = COALESCE((
                SELECT m2.tool_call
                FROM llm_metadata AS m2
                WHERE lower(m2.model_id) LIKE '%' || lower(models.model_id) || '%'
                ORDER BY
                    (m2.attachment + m2.open_weights + m2.reasoning + m2.temperature + m2.tool_call +
                        CASE WHEN m2.modalities IS NOT NULL AND m2.modalities <> '' THEN 1 ELSE 0 END
                    ) DESC,
                    length(m2.model_id) DESC
                LIMIT 1
            ), tool_call),
            knowledge = COALESCE((
                SELECT m2.knowledge
                FROM llm_metadata AS m2
                WHERE lower(m2.model_id) LIKE '%' || lower(models.model_id) || '%'
                ORDER BY
                    (m2.attachment + m2.open_weights + m2.reasoning + m2.temperature + m2.tool_call +
                        CASE WHEN m2.modalities IS NOT NULL AND m2.modalities <> '' THEN 1 ELSE 0 END
                    ) DESC,
                    length(m2.model_id) DESC
                LIMIT 1
            ), knowledge),
            context_limit = COALESCE((
                SELECT json_extract(m2."limit", '$.context')
                FROM llm_metadata AS m2
                WHERE lower(m2.model_id) LIKE '%' || lower(models.model_id) || '%'
                ORDER BY
                    (m2.attachment + m2.open_weights + m2.reasoning + m2.temperature + m2.tool_call +
                        CASE WHEN m2.modalities IS NOT NULL AND m2.modalities <> '' THEN 1 ELSE 0 END
                    ) DESC,
                    length(m2.model_id) DESC
                LIMIT 1
            ), context_limit),
            output_limit = COALESCE((
                SELECT json_extract(m2."limit", '$.output')
                FROM llm_metadata AS m2
                WHERE lower(m2.model_id) LIKE '%' || lower(models.model_id) || '%'
                ORDER BY
                    (m2.attachment + m2.open_weights + m2.reasoning + m2.temperature + m2.tool_call +
                        CASE WHEN m2.modalities IS NOT NULL AND m2.modalities <> '' THEN 1 ELSE 0 END
                    ) DESC,
                    length(m2.model_id) DESC
                LIMIT 1
            ), output_limit),
            updated_at = datetime('now')
        WHERE is_custom_metadata = 0
          AND EXISTS (
            SELECT 1
            FROM llm_metadata AS m2
            WHERE lower(m2.model_id) LIKE '%' || lower(models.model_id) || '%'
        )
    `);

    await database.run(updateSql);
};
