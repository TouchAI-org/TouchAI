// Copyright (c) 2025. 千诚. Licensed under GPL v3

import { sql, UpdateResult } from 'kysely';

import { db } from '../index';
import type { Model, ModelUpdate, NewModel } from '../schema';

/**
 * 根据 ID 查找模型
 */
export const findModelById = (id: number) =>
    db.getKysely().selectFrom('models').selectAll().where('id', '=', id).executeTakeFirst();

/**
 * 查找全局默认模型
 */
export const findDefaultModel = () =>
    db.getKysely().selectFrom('models').selectAll().where('is_default', '=', 1).executeTakeFirst();

/**
 * 查找默认模型且服务商已启用（包含服务商信息和元数据）
 */
export const findDefaultModelWithProvider = () =>
    sql`
        SELECT
            models.*,
            providers.name AS provider_name,
            providers.type AS provider_type,
            providers.api_endpoint,
            providers.api_key,
            providers.enabled AS provider_enabled,
            providers.logo AS provider_logo,
            llm_metadata.attachment AS metadata_attachment,
            llm_metadata.modalities AS metadata_modalities,
            llm_metadata.open_weights AS metadata_open_weights,
            llm_metadata.reasoning AS metadata_reasoning,
            llm_metadata.release_date AS metadata_release_date,
            llm_metadata.temperature AS metadata_temperature,
            llm_metadata.tool_call AS metadata_tool_call,
            llm_metadata.knowledge AS metadata_knowledge,
            llm_metadata."limit" AS metadata_limit
        FROM models
        INNER JOIN providers ON providers.id = models.provider_id
        LEFT JOIN llm_metadata
            ON llm_metadata.id = (
                SELECT m2.id
                FROM llm_metadata AS m2
                WHERE lower(m2.model_id) LIKE '%' || lower(models.model_id) || '%'
                ORDER BY
                    (
                        COALESCE(m2.attachment, 0)
                        + COALESCE(m2.open_weights, 0)
                        + COALESCE(m2.reasoning, 0)
                        + COALESCE(m2.temperature, 0)
                        + COALESCE(m2.tool_call, 0)
                        + CASE
                            WHEN m2.modalities IS NOT NULL AND m2.modalities <> '' THEN 1
                            ELSE 0
                        END
                    ) DESC,
                    length(m2.model_id) DESC
                LIMIT 1
            )
        WHERE models.is_default = 1 AND providers.enabled = 1
        ORDER BY models.id ASC
        LIMIT 1
    `
        .execute(db.getKysely())
        .then((result) => result.rows[0] ?? null);

export interface ModelWithProviderAndMetadata {
    id: number;
    created_at: string;
    updated_at: string;
    provider_id: number;
    model_id: string;
    name: string;
    is_default: number;
    last_used_at: string | null;
    provider_name: string;
    provider_type: string;
    api_endpoint: string;
    api_key: string | null;
    provider_enabled: number;
    provider_logo: string;
    metadata_attachment: number | null;
    metadata_modalities: string | null;
    metadata_open_weights: number | null;
    metadata_reasoning: number | null;
    metadata_release_date: string | null;
    metadata_temperature: number | null;
    metadata_tool_call: number | null;
    metadata_knowledge: string | null;
    metadata_limit: string | null;
}

/**
 * 查找模型并关联服务商信息和元数据（JOIN 查询）
 * 使用 LIKE 匹配，忽略大小写，允许部分匹配
 * 例如：models.model_id = "gpt-4-turbo" 可以匹配 llm_metadata.model_id = "gpt-4"
 * 如果匹配到多个metadata记录，只取第一个（按model_id长度降序，优先匹配更具体的）
 */
export const findModelsWithProvider = (
    providerId?: number
): Promise<ModelWithProviderAndMetadata[]> => {
    const whereClause =
        providerId !== undefined ? sql`WHERE models.provider_id = ${providerId}` : sql``;

    const query = sql<ModelWithProviderAndMetadata>`
        SELECT
            models.*,
            providers.name AS provider_name,
            providers.type AS provider_type,
            providers.api_endpoint,
            providers.api_key,
            providers.enabled AS provider_enabled,
            providers.logo AS provider_logo,
            llm_metadata.attachment AS metadata_attachment,
            llm_metadata.modalities AS metadata_modalities,
            llm_metadata.open_weights AS metadata_open_weights,
            llm_metadata.reasoning AS metadata_reasoning,
            llm_metadata.release_date AS metadata_release_date,
            llm_metadata.temperature AS metadata_temperature,
            llm_metadata.tool_call AS metadata_tool_call,
            llm_metadata.knowledge AS metadata_knowledge,
            llm_metadata."limit" AS metadata_limit
        FROM models
        INNER JOIN providers ON providers.id = models.provider_id
        LEFT JOIN llm_metadata
            ON llm_metadata.id = (
                SELECT m2.id
                FROM llm_metadata AS m2
                WHERE lower(m2.model_id) LIKE '%' || lower(models.model_id) || '%'
                ORDER BY
                    (
                        COALESCE(m2.attachment, 0)
                        + COALESCE(m2.open_weights, 0)
                        + COALESCE(m2.reasoning, 0)
                        + COALESCE(m2.temperature, 0)
                        + COALESCE(m2.tool_call, 0)
                        + CASE
                            WHEN m2.modalities IS NOT NULL AND m2.modalities <> '' THEN 1
                            ELSE 0
                        END
                    ) DESC,
                    length(m2.model_id) DESC
                LIMIT 1
            )
        ${whereClause}
        ORDER BY models.is_default DESC, models.id ASC
    `;

    return query
        .execute(db.getKysely())
        .then((result) => result.rows as ModelWithProviderAndMetadata[]);
};

/**
 * 创建模型
 */
export const createModel = async (data: NewModel): Promise<Model> => {
    const result = await db
        .getKysely()
        .insertInto('models')
        .values(data)
        .returningAll()
        .executeTakeFirst();

    if (!result) {
        // 如果 returning 不工作，尝试获取最后插入的记录
        const lastInsert = await db
            .getKysely()
            .selectFrom('models')
            .selectAll()
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();

        if (!lastInsert) {
            throw new Error('Failed to create model');
        }
        return lastInsert;
    }

    return result;
};

/**
 * 批量创建模型
 */
export const createModels = async (data: NewModel[]): Promise<void> => {
    if (data.length === 0) return;

    await db.getKysely().insertInto('models').values(data).execute();

    return;
};

/**
 * 更新模型
 */
export const updateModel = async (id: number, data: ModelUpdate): Promise<UpdateResult> => {
    const result = await db
        .getKysely()
        .updateTable('models')
        .set(data)
        .where('id', '=', id)
        .executeTakeFirst();

    if (!result || result.numUpdatedRows === 0n) {
        throw new Error(`Model with id ${id} not found`);
    }
    return result;
};

/**
 * 更新模型最后使用时间
 */
export const updateModelLastUsed = (id: number) =>
    updateModel(id, { last_used_at: new Date().toISOString() });

/**
 * 设置全局默认模型
 * 使用事务确保只有一个默认模型
 * 验证：模型所属的服务商必须已启用
 */
export const setDefaultModel = async (modelId: number): Promise<void> => {
    // 检查模型是否存在以及服务商是否启用
    const modelWithProvider = await db
        .getKysely()
        .selectFrom('models')
        .innerJoin('providers', 'providers.id', 'models.provider_id')
        .select(['models.id', 'providers.enabled', 'providers.name as provider_name'])
        .where('models.id', '=', modelId)
        .executeTakeFirst();

    if (!modelWithProvider) {
        throw new Error('模型不存在');
    }

    if (modelWithProvider.enabled === 0) {
        throw new Error(`无法设置默认模型：服务商 "${modelWithProvider.provider_name}" 未启用`);
    }

    await db
        .getKysely()
        .transaction()
        .execute(async (trx) => {
            // 取消所有默认设置
            await trx.updateTable('models').set({ is_default: 0 }).execute();

            // 设置新的默认模型
            await trx
                .updateTable('models')
                .set({ is_default: 1 })
                .where('id', '=', modelId)
                .execute();
        });
};

/**
 * 检查服务商是否有默认模型
 */
export const providerHasDefaultModel = async (providerId: number): Promise<boolean> => {
    const model = await db
        .getKysely()
        .selectFrom('models')
        .select('id')
        .where('provider_id', '=', providerId)
        .where('is_default', '=', 1)
        .executeTakeFirst();

    return !!model;
};

/**
 * 删除模型
 */
export const deleteModel = async (id: number): Promise<boolean> => {
    const result = await db
        .getKysely()
        .deleteFrom('models')
        .where('id', '=', id)
        .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
};

/**
 * 统计模型数量
 */
export const countModels = async (): Promise<number> => {
    const result = await db
        .getKysely()
        .selectFrom('models')
        .select((eb) => eb.fn.countAll().as('count'))
        .executeTakeFirst();
    return Number(result?.count || 0);
};

/**
 * 根据 model_id 查找模型（包含服务商信息）
 */
export const findModelByModelId = (modelId: string) =>
    db
        .getKysely()
        .selectFrom('models')
        .innerJoin('providers', 'providers.id', 'models.provider_id')
        .selectAll('models')
        .select([
            'providers.name as provider_name',
            'providers.type as provider_type',
            'providers.api_endpoint',
            'providers.api_key',
            'providers.enabled as provider_enabled',
            'providers.logo as provider_logo',
        ])
        .where('models.model_id', '=', modelId)
        .executeTakeFirst();

/**
 * 根据 provider_id 和 model_id 查找模型（包含服务商信息）
 * 用于精确定位特定提供商的特定模型
 */
export const findModelByProviderAndModelId = (providerId: number, modelId: string) =>
    db
        .getKysely()
        .selectFrom('models')
        .innerJoin('providers', 'providers.id', 'models.provider_id')
        .selectAll('models')
        .select([
            'providers.name as provider_name',
            'providers.type as provider_type',
            'providers.api_endpoint',
            'providers.api_key',
            'providers.enabled as provider_enabled',
            'providers.logo as provider_logo',
        ])
        .where('models.provider_id', '=', providerId)
        .where('models.model_id', '=', modelId)
        .executeTakeFirst();
