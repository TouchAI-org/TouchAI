// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { eq } from 'drizzle-orm';

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
