// Copyright (c) 2025. 千诚. Licensed under GPL v3

import { UpdateResult } from 'kysely';

import { db } from '../index';
import type { NewSetting, Setting, SettingUpdate } from '../schema';
import { SettingKey } from '../schema';

/**
 * 根据 ID 查找设置
 */
export const findSettingById = async (id: number) =>
    (await db.getKysely())
        .selectFrom('settings')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();

/**
 * 根据 key 查找设置
 */
export const findSettingByKey = async (key: string | SettingKey) =>
    (await db.getKysely())
        .selectFrom('settings')
        .selectAll()
        .where('key', '=', key)
        .executeTakeFirst();

/**
 * 获取设置值
 */
export const getSettingValue = async (key: string | SettingKey): Promise<string | null> => {
    const setting = await findSettingByKey(key);
    return setting?.value || null;
};

/**
 * 查找所有设置
 */
export const findAllSettings = async () =>
    (await db.getKysely()).selectFrom('settings').selectAll().orderBy('key', 'asc').execute();

/**
 * 创建设置
 */
export const createSetting = async (data: NewSetting): Promise<Setting> => {
    await (await db.getKysely()).insertInto('settings').values(data).execute();

    // 获取最后插入的记录
    const lastInsert = await (await db.getKysely())
        .selectFrom('settings')
        .selectAll()
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();

    if (!lastInsert) {
        throw new Error('Failed to create setting');
    }
    return lastInsert;
};

/**
 * 更新设置
 */
export const updateSetting = async (id: number, data: SettingUpdate): Promise<UpdateResult> => {
    const result = await (await db.getKysely())
        .updateTable('settings')
        .set(data)
        .where('id', '=', id)
        .executeTakeFirst();

    if (!result || result.numUpdatedRows === 0n) {
        throw new Error(`Setting with id ${id} not found`);
    }

    return result;
};

/**
 * 根据 key 更新设置值
 */
export const updateSettingValue = async (
    key: string | SettingKey,
    value: string
): Promise<UpdateResult> => {
    const result = await (await db.getKysely())
        .updateTable('settings')
        .set({ value })
        .where('key', '=', key)
        .executeTakeFirst();

    if (!result || result.numUpdatedRows === 0n) {
        throw new Error(`Setting with key ${key} not found`);
    }

    return result;
};

/**
 * 设置值（不存在则创建）
 */
export const setSetting = async (
    key: string | SettingKey,
    value: string,
    description?: string
): Promise<Setting> => {
    const existing = await findSettingByKey(key);

    if (existing) {
        await updateSettingValue(key, value);
        return findSettingByKey(key) as Promise<Setting>;
    } else {
        return createSetting({ key, value, description: description || null });
    }
};

/**
 * 删除设置
 */
export const deleteSetting = async (id: number): Promise<boolean> => {
    const result = await (await db.getKysely())
        .deleteFrom('settings')
        .where('id', '=', id)
        .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
};

/**
 * 根据 key 删除设置
 */
export const deleteSettingByKey = async (key: string | SettingKey): Promise<boolean> => {
    const result = await (await db.getKysely())
        .deleteFrom('settings')
        .where('key', '=', key)
        .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
};

/**
 * 批量获取设置
 */
export const getSettings = async (
    keys: (string | SettingKey)[]
): Promise<Record<string, string | null>> => {
    const settings = await (await db.getKysely())
        .selectFrom('settings')
        .select(['key', 'value'])
        .where('key', 'in', keys)
        .execute();

    return Object.fromEntries(settings.map((s) => [s.key, s.value]));
};

/**
 * 批量设置值
 */
export const setSettings = async (values: Record<string, string>): Promise<void> => {
    for (const [key, value] of Object.entries(values)) {
        await setSetting(key, value);
    }
};

/**
 * 检查 key 是否存在
 */
export const settingKeyExists = async (key: string | SettingKey): Promise<boolean> => {
    const result = await (await db.getKysely())
        .selectFrom('settings')
        .select('id')
        .where('key', '=', key)
        .executeTakeFirst();

    return result !== undefined;
};
