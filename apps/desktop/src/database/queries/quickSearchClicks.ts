// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { desc, eq, sql } from 'drizzle-orm';

import { db } from '../index';
import { quickSearchClickStats } from '../schema';

export interface QuickSearchClickStatRow {
    query_norm: string;
    path_norm: string;
    click_count: number;
}

/**
 * 按规范化查询词读取点击统计行。
 */
export async function findQuickSearchClicksByQuery({
    queryNorm,
    limit,
}: {
    queryNorm: string;
    limit: number;
}): Promise<QuickSearchClickStatRow[]> {
    return db
        .select({
            path_norm: quickSearchClickStats.path_norm,
            click_count: quickSearchClickStats.click_count,
            query_norm: quickSearchClickStats.query_norm,
        })
        .from(quickSearchClickStats)
        .where(eq(quickSearchClickStats.query_norm, queryNorm))
        .orderBy(desc(quickSearchClickStats.click_count), desc(quickSearchClickStats.updated_at))
        .limit(limit)
        .all();
}

/**
 * 记录一次点击（不存在则插入，存在则自增）。
 */
export async function upsertQuickSearchClick({
    queryNorm,
    pathNorm,
    maxClickCount,
}: {
    queryNorm: string;
    pathNorm: string;
    maxClickCount: number;
}): Promise<void> {
    if (!queryNorm || !pathNorm) return;
    await db
        .insert(quickSearchClickStats)
        .values({
            query_norm: queryNorm,
            path_norm: pathNorm,
            click_count: 1,
        })
        .onConflictDoUpdate({
            target: [quickSearchClickStats.query_norm, quickSearchClickStats.path_norm],
            set: {
                click_count: sql`CASE
                    WHEN ${quickSearchClickStats.click_count} >= ${maxClickCount} THEN ${maxClickCount}
                    ELSE ${quickSearchClickStats.click_count} + 1
                END`,
                updated_at: sql`datetime('now')`,
            },
        })
        .run();
}
