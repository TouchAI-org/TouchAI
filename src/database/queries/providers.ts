// Copyright (c) 2025. 千诚. Licensed under GPL v3

import { UpdateResult } from 'kysely';

import { db } from '../index';
import type { NewProvider, Provider, ProviderUpdate } from '../schema';

/**
 * 查找所有服务商，按优先级排序
 * 排序规则：
 * 1. 启用的服务商排在前面
 * 2. 启用的服务商中，有默认模型的排在最前面
 * 3. 其他按 ID 排序
 */
export const findAllProvidersSorted = async () => {
    const providers = await (await db.getKysely()).selectFrom('providers').selectAll().execute();

    const models = await (await db.getKysely()).selectFrom('models').selectAll().execute();

    // 找出有默认模型的服务商 ID
    const defaultModelProviderId = models.find((m) => m.is_default === 1)?.provider_id;

    // 排序
    return providers.sort((a, b) => {
        // 1. 启用的排前面
        if (a.enabled !== b.enabled) {
            return b.enabled - a.enabled;
        }

        // 2. 启用的服务商中，有默认模型的排最前面
        if (a.enabled === 1) {
            const aHasDefault = a.id === defaultModelProviderId ? 1 : 0;
            const bHasDefault = b.id === defaultModelProviderId ? 1 : 0;
            if (aHasDefault !== bHasDefault) {
                return bHasDefault - aHasDefault;
            }
        }

        // 3. 其他按 ID 排序
        return a.id - b.id;
    });
};

/**
 * 根据 ID 查找服务商
 */
export const findProviderById = async (id: number) =>
    (await db.getKysely())
        .selectFrom('providers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();

/**
 * 查找所有启用的服务商
 */
export const findEnabledProviders = async () =>
    (await db.getKysely()).selectFrom('providers').selectAll().where('enabled', '=', 1).execute();

/**
 * 查找所有内置服务商
 */
export const findBuiltinProviders = async () =>
    (await db.getKysely())
        .selectFrom('providers')
        .selectAll()
        .where('is_builtin', '=', 1)
        .execute();

/**
 * 创建服务商
 */
export const createProvider = async (data: NewProvider): Promise<Provider> => {
    const result = await (await db.getKysely())
        .insertInto('providers')
        .values(data)
        .returningAll()
        .executeTakeFirst();

    if (!result) {
        // 如果 returning 不工作，尝试获取最后插入的记录
        const lastInsert = await (await db.getKysely())
            .selectFrom('providers')
            .selectAll()
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();

        if (!lastInsert) {
            throw new Error('Failed to create provider');
        }
        return lastInsert;
    }

    return result;
};

/**
 * 更新服务商
 * 验证：如果服务商有默认模型，则不能禁用
 */
export const updateProvider = async (id: number, data: ProviderUpdate): Promise<UpdateResult> => {
    // 如果尝试禁用服务商，检查是否有默认模型
    if (data.enabled === 0) {
        const defaultModel = await (await db.getKysely())
            .selectFrom('models')
            .selectAll()
            .where('provider_id', '=', id)
            .where('is_default', '=', 1)
            .executeTakeFirst();

        if (defaultModel) {
            throw new Error('无法禁用包含默认模型的服务商，请先设置其他模型为默认');
        }
    }

    const result = await (await db.getKysely())
        .updateTable('providers')
        .set(data)
        .where('id', '=', id)
        .executeTakeFirst();

    if (!result || result.numUpdatedRows === 0n) {
        throw new Error(`Provider with id ${id} not found`);
    }
    return result;
};

/**
 * 删除服务商
 * 验证：不能删除内置服务商或包含默认模型的服务商
 */
export const deleteProvider = async (id: number): Promise<boolean> => {
    const provider = await findProviderById(id);

    if (!provider) {
        throw new Error(`Provider with id ${id} not found`);
    }

    if (provider.is_builtin) {
        throw new Error('无法删除内置服务商');
    }

    // 检查是否有默认模型
    const defaultModel = await (await db.getKysely())
        .selectFrom('models')
        .selectAll()
        .where('provider_id', '=', id)
        .where('is_default', '=', 1)
        .executeTakeFirst();

    if (defaultModel) {
        throw new Error('无法删除包含默认模型的服务商，请先设置其他模型为默认');
    }

    const result = await (await db.getKysely())
        .deleteFrom('providers')
        .where('id', '=', id)
        .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
};
