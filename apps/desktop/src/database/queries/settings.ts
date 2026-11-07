// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { eq, inArray } from 'drizzle-orm';

import { db } from '../index';
import { settings } from '../schema';
import type { SettingEntity, SettingIdentifier } from '../types';

/**
 * 根据 key 查找设置
 */
export const findSettingByKey = async ({
    key,
}: {
    key: SettingIdentifier;
}): Promise<SettingEntity | undefined> =>
    await db.select().from(settings).where(eq(settings.key, key)).get();

/**
 * 获取设置值
 */
export const getSettingValue = async ({
    key,
}: {
    key: SettingIdentifier;
}): Promise<string | null> => {
    const setting = await findSettingByKey({ key });
    return setting?.value ?? null;
};

/**
 * 批量获取设置值。
 *
 * 启动初始化需要读取全部通用配置；一次 SELECT 返回 key/value，
 * 避免按 key 发出 N 次跨 IPC 查询。缺失的 key 以 null 补齐。
 */
export const getSettingValues = async ({
    keys,
}: {
    keys: SettingIdentifier[];
}): Promise<Record<string, string | null>> => {
    if (keys.length === 0) {
        return {};
    }

    const rows = await db
        .select({ key: settings.key, value: settings.value })
        .from(settings)
        .where(inArray(settings.key, keys))
        .all();
    const valuesByKey = new Map(rows.map((row) => [row.key, row.value ?? null]));

    return Object.fromEntries(keys.map((key) => [key, valuesByKey.get(key) ?? null]));
};

/**
 * 设置值（不存在则创建）。
 */
export const setSetting = async ({
    key,
    value,
}: {
    key: SettingIdentifier;
    value: string;
}): Promise<SettingEntity> => {
    const result = await db
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .returning()
        .get();

    if (!result || result.key === undefined) {
        throw new Error(`Failed to set setting: ${key}`);
    }

    return result;
};
