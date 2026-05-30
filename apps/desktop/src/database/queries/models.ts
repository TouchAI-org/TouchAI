// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { tt } from '@/i18n';

import { type DatabaseExecutor, db } from '../index';
import { modelPreferences, models, providers } from '../schema';
import type {
    FindModelsWithProviderPayload,
    ModelCreateData,
    ModelEntity,
    ModelPreferenceCreateData,
    ModelPreferenceEntity,
    ModelPreferenceUpdateData,
    ModelPreferenceWithModel,
    ModelUpdateData,
    ModelWithProvider,
    ProviderModelLookupPayload,
} from '../types';
import { getSettingValue, setSetting } from './settings';

export type { ModelWithProvider } from '../types';

export type ModelRole = 'entry' | 'fast' | 'general';

const MODEL_ROLE_SETTING_KEYS: Record<Exclude<ModelRole, 'entry'>, string> = {
    fast: 'model_role_fast_model_id',
    general: 'model_role_general_model_id',
};

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

export const modelPreferenceWithModelSelection = {
    id: modelPreferences.id,
    name: modelPreferences.name,
    description: modelPreferences.description,
    provider_id: modelPreferences.provider_id,
    model_id: modelPreferences.model_id,
    priority: modelPreferences.priority,
    created_at: modelPreferences.created_at,
    updated_at: modelPreferences.updated_at,
    model_name: sql<string | null>`${models.name}`.as('model_name'),
    model_api_id: sql<string | null>`${models.model_id}`.as('model_api_id'),
    model_provider_id: sql<number | null>`${models.provider_id}`.as('model_provider_id'),
    provider_name: sql<string | null>`${providers.name}`.as('provider_name'),
    provider_enabled: sql<number | null>`${providers.enabled}`.as('provider_enabled'),
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

function normalizeModelPreferenceDraft<
    T extends ModelPreferenceCreateData | ModelPreferenceUpdateData,
>(draft: T): T {
    return {
        ...draft,
        ...(draft.name !== undefined ? { name: draft.name.trim() } : {}),
        ...(draft.description !== undefined ? { description: draft.description.trim() } : {}),
        ...(draft.updated_at === undefined ? { updated_at: new Date().toISOString() } : {}),
    };
}

export const listModelPreferences = async (): Promise<ModelPreferenceWithModel[]> =>
    (await db
        .select(modelPreferenceWithModelSelection)
        .from(modelPreferences)
        .leftJoin(models, eq(models.id, modelPreferences.model_id))
        .leftJoin(providers, eq(providers.id, models.provider_id))
        .orderBy(asc(modelPreferences.priority), asc(modelPreferences.id))
        .all()) as ModelPreferenceWithModel[];

export const findModelPreferenceByName = async (
    name: string
): Promise<ModelPreferenceWithModel | undefined> =>
    (await db
        .select(modelPreferenceWithModelSelection)
        .from(modelPreferences)
        .leftJoin(models, eq(models.id, modelPreferences.model_id))
        .leftJoin(providers, eq(providers.id, models.provider_id))
        .where(eq(modelPreferences.name, name.trim()))
        .orderBy(asc(modelPreferences.priority), asc(modelPreferences.id))
        .limit(1)
        .get()) as ModelPreferenceWithModel | undefined;

export const createModelPreference = async (
    preferenceDraft: ModelPreferenceCreateData
): Promise<ModelPreferenceEntity> => {
    const normalizedDraft = normalizeModelPreferenceDraft(preferenceDraft);
    if (!normalizedDraft.name?.trim()) {
        throw new Error('Model preference name is required');
    }
    if (!normalizedDraft.description?.trim()) {
        throw new Error('Model preference description is required');
    }

    const createdPreference = await db
        .insert(modelPreferences)
        .values(normalizedDraft)
        .returning()
        .get();

    if (!createdPreference || createdPreference.id === undefined) {
        throw new Error('Failed to create model preference');
    }

    return createdPreference;
};

export const updateModelPreference = async (
    id: number,
    preferencePatch: ModelPreferenceUpdateData
): Promise<void> => {
    const normalizedPatch = normalizeModelPreferenceDraft(preferencePatch);
    if (normalizedPatch.name !== undefined && !normalizedPatch.name.trim()) {
        throw new Error('Model preference name is required');
    }
    if (normalizedPatch.description !== undefined && !normalizedPatch.description.trim()) {
        throw new Error('Model preference description is required');
    }

    await db.update(modelPreferences).set(normalizedPatch).where(eq(modelPreferences.id, id)).run();
};

export const deleteModelPreference = async (id: number): Promise<boolean> => {
    await db.delete(modelPreferences).where(eq(modelPreferences.id, id)).run();
    return true;
};

export const findModelByIdWithProvider = async (
    id: number
): Promise<ModelWithProvider | undefined> =>
    (await db
        .select(modelWithProviderSelection)
        .from(models)
        .innerJoin(providers, eq(providers.id, models.provider_id))
        .where(eq(models.id, id))
        .get()) as ModelWithProvider | undefined;

async function requireEnabledModelById(id: number): Promise<ModelWithProvider> {
    const model = await findModelByIdWithProvider(id);
    if (!model) {
        throw new Error('Model not found');
    }
    if (model.provider_enabled === 0) {
        throw new Error(
            tt('无法选择模型：服务商 "{provider}" 未启用', {
                provider: model.provider_name,
            })
        );
    }
    return model;
}

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

export const findModelRoleWithProvider = async (
    role: ModelRole
): Promise<ModelWithProvider | null> => {
    if (role === 'entry') {
        return findDefaultModelWithProvider();
    }

    const rawModelId = await getSettingValue({ key: MODEL_ROLE_SETTING_KEYS[role] });
    const modelId = rawModelId ? Number(rawModelId) : NaN;
    if (!Number.isFinite(modelId)) {
        return null;
    }

    const model = await findModelByIdWithProvider(modelId);
    if (!model || model.provider_enabled === 0) {
        return null;
    }

    return model;
};

export const findEffectiveModelRoleWithProvider = async (
    role: ModelRole
): Promise<ModelWithProvider | null> => {
    const roleModel = await findModelRoleWithProvider(role);
    if (roleModel) {
        return roleModel;
    }
    return findDefaultModelWithProvider();
};

export const setModelRole = async ({
    role,
    modelId,
}: {
    role: ModelRole;
    modelId: number | null;
}): Promise<void> => {
    if (role === 'entry') {
        if (modelId === null) {
            throw new Error('Entry model is required');
        }
        await setDefaultModel({ modelId });
        return;
    }

    if (modelId !== null) {
        await requireEnabledModelById(modelId);
    }

    await setSetting({
        key: MODEL_ROLE_SETTING_KEYS[role],
        value: modelId === null ? '' : String(modelId),
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
