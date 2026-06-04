// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { asc, count, desc, eq } from 'drizzle-orm';

import { db } from '../index';
import { builtInTools } from '../schema';
import type { BuiltInToolCreateData, BuiltInToolEntity, BuiltInToolUpdateData } from '../types';

/**
 * 查询全部内置工具。
 */
export const findAllBuiltInTools = async (): Promise<BuiltInToolEntity[]> =>
    db
        .select()
        .from(builtInTools)
        .orderBy(desc(builtInTools.enabled), asc(builtInTools.display_name))
        .all();

/**
 * 查询全部启用的内置工具。
 */
export const findEnabledBuiltInTools = async (): Promise<BuiltInToolEntity[]> =>
    db
        .select()
        .from(builtInTools)
        .where(eq(builtInTools.enabled, 1))
        .orderBy(asc(builtInTools.display_name))
        .all();

/**
 * 根据数据库 ID 查询内置工具。
 */
export const findBuiltInToolById = async (id: number): Promise<BuiltInToolEntity | undefined> =>
    await db.select().from(builtInTools).where(eq(builtInTools.id, id)).get();

/**
 * 根据 tool_id 查询内置工具。
 */
export const findBuiltInToolByToolId = async (
    toolId: string
): Promise<BuiltInToolEntity | undefined> =>
    await db.select().from(builtInTools).where(eq(builtInTools.tool_id, toolId)).get();

/**
 * 创建内置工具记录。
 */
export const createBuiltInTool = async (
    data: BuiltInToolCreateData
): Promise<BuiltInToolEntity> => {
    const createdTool = await db.insert(builtInTools).values(data).returning().get();

    if (!createdTool || createdTool.id === undefined) {
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
    const updatedTool = await db
        .update(builtInTools)
        .set(data)
        .where(eq(builtInTools.id, id))
        .returning()
        .get();

    return updatedTool && updatedTool.id !== undefined ? updatedTool : undefined;
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

    return await db.transaction(async (tx) => {
        const updatedTools: BuiltInToolEntity[] = [];
        for (const id of ids) {
            const updatedTool = await tx
                .update(builtInTools)
                .set(data)
                .where(eq(builtInTools.id, id))
                .returning()
                .get();
            if (!updatedTool || updatedTool.id === undefined) {
                throw new Error(`Built-in tool not found after update: ${id}`);
            }
            updatedTools.push(updatedTool);
        }
        return updatedTools;
    });
};

/**
 * 更新内置工具最近一次使用时间。
 */
export const touchBuiltInToolLastUsed = async (
    toolId: string,
    lastUsedAt = new Date().toISOString()
): Promise<void> => {
    await db
        .update(builtInTools)
        .set({ last_used_at: lastUsedAt })
        .where(eq(builtInTools.tool_id, toolId))
        .run();
};

/**
 * 统计启用中的内置工具数量。
 */
export const countEnabledBuiltInTools = async (): Promise<number> => {
    const result = await db
        .select({ count: count() })
        .from(builtInTools)
        .where(eq(builtInTools.enabled, 1))
        .get();

    return result?.count || 0;
};
