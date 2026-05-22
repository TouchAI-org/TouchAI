// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { eq } from 'drizzle-orm';

import { db } from '../index';
import { models, providers } from '../schema';
import type { ProviderCreateData, ProviderEntity, ProviderUpdateData } from '../types';

/**
 * 查找所有服务商，按优先级排序
 * 排序规则：
 * 1. 启用的服务商排在前面
 * 2. 启用的服务商中，有默认模型的排在最前面
 * 3. 其他按 ID 排序
 */
export const findAllProvidersSorted = async (): Promise<ProviderEntity[]> => {
    const drizzle = db;
    const allProviders = await drizzle.select().from(providers).all();
    const allModels = await drizzle.select().from(models).all();

    // 找出有默认模型的服务商 ID
    const defaultModelProviderId = allModels.find((m) => m.is_default === 1)?.provider_id;

    // 排序
    return allProviders.sort((a, b) => {
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
export const findProviderById = async ({
    id,
}: {
    id: number;
}): Promise<ProviderEntity | undefined> =>
    await db.select().from(providers).where(eq(providers.id, id)).get();

/**
 * 创建服务商
 */
export const createProvider = async (
    providerDraft: ProviderCreateData
): Promise<ProviderEntity> => {
    const createdProvider = await db.insert(providers).values(providerDraft).returning().get();

    if (!createdProvider || createdProvider.id === undefined) {
        throw new Error('Failed to create provider');
    }

    return createdProvider;
};

/**
 * 更新服务商
 */
export const updateProvider = async ({
    id,
    providerPatch,
}: {
    id: number;
    providerPatch: ProviderUpdateData;
}): Promise<void> => {
    await db.update(providers).set(providerPatch).where(eq(providers.id, id)).run();
};

/**
 * 删除服务商
 */
export const deleteProvider = async ({ id }: { id: number }): Promise<boolean> => {
    await db.delete(providers).where(eq(providers.id, id)).run();
    return true;
};
