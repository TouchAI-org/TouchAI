// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import type { BuiltInToolCreateData, BuiltInToolEntity, BuiltInToolUpdateData } from '../types';

/**
 * 查询全部内置工具。
 */
export const findAllBuiltInTools = async (): Promise<BuiltInToolEntity[]> =>
    native.database.operation<BuiltInToolEntity[]>({
        kind: 'built_in_tool_list',
        enabledOnly: false,
    });

/**
 * 查询全部启用的内置工具。
 */
export const findEnabledBuiltInTools = async (): Promise<BuiltInToolEntity[]> =>
    native.database.operation<BuiltInToolEntity[]>({
        kind: 'built_in_tool_list',
        enabledOnly: true,
    });

/**
 * 根据数据库 ID 查询内置工具。
 */
export const findBuiltInToolById = async (id: number): Promise<BuiltInToolEntity | undefined> =>
    (await native.database.operation<BuiltInToolEntity | null>({
        kind: 'built_in_tool_find_by_id',
        id,
    })) ?? undefined;

/**
 * 根据 tool_id 查询内置工具。
 */
export const findBuiltInToolByToolId = async (
    toolId: string
): Promise<BuiltInToolEntity | undefined> =>
    (await native.database.operation<BuiltInToolEntity | null>({
        kind: 'built_in_tool_find_by_tool_id',
        toolId,
    })) ?? undefined;

/**
 * 创建内置工具记录。
 */
export const createBuiltInTool = async (
    data: BuiltInToolCreateData
): Promise<BuiltInToolEntity> => {
    const createdTool = await native.database.operation<BuiltInToolEntity | null>({
        kind: 'built_in_tool_create',
        data: { ...data },
    });

    if (!createdTool) {
        throw new Error('Failed to create built-in tool');
    }

    return createdTool;
};

/**
 * 更新内置工具配置。
 */
export const updateBuiltInTool = async (
    id: number,
    data: BuiltInToolUpdateData
): Promise<BuiltInToolEntity | undefined> => {
    return (
        (await native.database.operation<BuiltInToolEntity | null>({
            kind: 'built_in_tool_update',
            id,
            data: { ...data },
        })) ?? undefined
    );
};

/**
 * 在同一个事务中更新多条内置工具配置。
 */
export const updateBuiltInTools = async (
    ids: number[],
    data: BuiltInToolUpdateData
): Promise<BuiltInToolEntity[]> => {
    if (ids.length === 0) {
        return [];
    }

    return native.database.operation<BuiltInToolEntity[]>({
        kind: 'built_in_tool_update_many',
        ids,
        data: { ...data },
    });
};

/**
 * 更新内置工具最近一次使用时间。
 */
export const touchBuiltInToolLastUsed = async (
    toolId: string,
    lastUsedAt = new Date().toISOString()
): Promise<void> => {
    await native.database.operation({
        kind: 'built_in_tool_touch',
        toolId,
        lastUsedAt,
    });
};

/**
 * 统计启用中的内置工具数量。
 */
export const countEnabledBuiltInTools = async (): Promise<number> => {
    return native.database.operation<number>({ kind: 'built_in_tool_count_enabled' });
};
