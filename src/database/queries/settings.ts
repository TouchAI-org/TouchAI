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
    (await db.getDb()).select().from(settings).where(eq(settings.key, key)).get();

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
 * 根据 key 更新设置值
 */
export const updateSettingValue = async ({
    key,
    value,
}: {
    key: SettingIdentifier;
    value: string;
}): Promise<void> => {
    const drizzle = await db.getDb();
    await drizzle
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run();
};

/**
 * 设置值（不存在则创建）
 */
export const setSetting = async ({
    key,
    value,
}: {
    key: SettingIdentifier;
    value: string;
}): Promise<SettingEntity> => {
    await updateSettingValue({ key, value });
    const result = await findSettingByKey({ key });
    if (!result) {
        throw new Error(`Failed to set setting: ${key}`);
    }
    return result;
};
