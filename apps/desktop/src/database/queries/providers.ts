// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import type { ProviderCreateData, ProviderEntity, ProviderUpdateData } from '../types';

/**
 * 查找所有服务商，按优先级排序
 * 排序规则：
 * 1. 启用的服务商排在前面
 * 2. 启用的服务商中，有默认模型的排在最前面
 * 3. 内置服务商按稳定展示顺序排序
 * 4. 其他按 ID 排序
 */
export const findAllProvidersSorted = async (): Promise<ProviderEntity[]> => {
    return native.database.operation<ProviderEntity[]>({ kind: 'provider_list' });
};

/**
 * 根据 ID 查找服务商
 */
export const findProviderById = async ({
    id,
}: {
    id: number;
}): Promise<ProviderEntity | undefined> =>
    (await native.database.operation<ProviderEntity | null>({ kind: 'provider_find', id })) ??
    undefined;

/**
 * 创建服务商
 */
export const createProvider = async (
    providerDraft: ProviderCreateData
): Promise<ProviderEntity> => {
    const createdProvider = await native.database.operation<ProviderEntity | null>({
        kind: 'provider_create',
        data: { ...providerDraft },
    });

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
    await native.database.operation({
        kind: 'provider_update',
        id,
        data: { ...providerPatch },
    });
};

/**
 * 删除服务商
 */
export const deleteProvider = async ({ id }: { id: number }): Promise<boolean> => {
    return native.database.operation<boolean>({ kind: 'provider_delete', id });
};
