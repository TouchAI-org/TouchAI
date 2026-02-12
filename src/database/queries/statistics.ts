// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { eq } from 'drizzle-orm';

import { db } from '../index';
import { statistics } from '../schema';
import type { StatisticIdentifier } from '../types';

/**
 * 获取统计值
 */
export const getStatistic = async ({
    key,
}: {
    key: StatisticIdentifier;
}): Promise<string | null> => {
    const statistic = await (await db.getDb())
        .select()
        .from(statistics)
        .where(eq(statistics.key, key))
        .get();
    return statistic?.value ?? null;
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
    const drizzle = await db.getDb();

    await drizzle
        .insert(statistics)
        .values({ key, value })
        .onConflictDoUpdate({
            target: statistics.key,
            set: { value },
        })
        .run();

    const updated = await getStatistic({ key });
    if (updated === null) {
        throw new Error('Failed to set statistic');
    }

    return true;
};
