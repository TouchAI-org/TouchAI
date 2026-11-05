// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import type { StatisticIdentifier } from '../types';

/**
 * 获取统计值
 */
export const getStatistic = async ({
    key,
}: {
    key: StatisticIdentifier;
}): Promise<string | null> => {
    return native.database.operation<string | null>({ kind: 'statistic_get', key });
};

/**
 * 设置统计值（不存在则创建）
 */
export const setStatistic = async ({
    key,
    value,
}: {
    key: StatisticIdentifier;
    value: string;
}): Promise<boolean> => {
    const updated = await native.database.operation<boolean>({
        kind: 'statistic_set',
        key,
        value,
    });
    if (!updated) {
        throw new Error('Failed to set statistic');
    }
    return true;
};
