// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import type { SettingEntity, SettingIdentifier } from '../types';

/**
 * 根据 key 查找设置
 */
export const findSettingByKey = async ({
    key,
}: {
    key: SettingIdentifier;
}): Promise<SettingEntity | undefined> =>
    (await native.database.operation<SettingEntity | null>({
        kind: 'setting_find',
        key,
    })) ?? undefined;

/**
 * 获取设置值
 */
export const getSettingValue = async ({
    key,
}: {
    key: SettingIdentifier;
}): Promise<string | null> => {
    return native.database.operation<string | null>({ kind: 'setting_get', key });
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
    const result = await native.database.operation<SettingEntity | null>({
        kind: 'setting_set',
        key,
        value,
    });
    if (!result) {
        throw new Error(`Failed to set setting: ${key}`);
    }
    return result;
};
