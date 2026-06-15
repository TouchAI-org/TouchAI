// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { eq } from 'drizzle-orm';

import { db } from '../index';
import { models, providers } from '../schema';
import type { ProviderCreateData, ProviderEntity, ProviderUpdateData } from '../types';

const BUILTIN_PROVIDER_DISPLAY_ORDER = new Map<string, number>([
    ['OpenAI', 0],
    ['Anthropic', 1],
    ['DeepSeek', 2],
    ['Xiaomi MiMo', 3],
    ['火山引擎', 4],
    ['Gemini', 5],
    ['Grok', 6],
    ['腾讯混元', 7],
    ['MiniMax', 8],
    ['月之暗面', 9],
    ['阿里云百炼', 10],
    ['智谱', 11],
]);

function getProviderDisplayOrder(provider: ProviderEntity): number {
    if (provider.is_builtin !== 1) {
        return Number.MAX_SAFE_INTEGER;
    }

    return BUILTIN_PROVIDER_DISPLAY_ORDER.get(provider.name) ?? Number.MAX_SAFE_INTEGER - 1;
}

/**
 * 查找所有服务商，按优先级排序
 * 排序规则：
 * 1. 启用的服务商排在前面
 * 2. 启用的服务商中，有默认模型的排在最前面
 * 3. 内置服务商按稳定展示顺序排序
 * 4. 其他按 ID 排序
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

        const providerOrderDelta = getProviderDisplayOrder(a) - getProviderDisplayOrder(b);
        if (providerOrderDelta !== 0) {
            return providerOrderDelta;
        }

        // 4. 其他按 ID 排序
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
