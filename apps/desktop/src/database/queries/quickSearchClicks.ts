// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

export interface QuickSearchClickStatRow {
    query_norm: string;
    path_norm: string;
    click_count: number;
}

export interface QuickSearchRecentClickStatRow extends QuickSearchClickStatRow {
    updated_at: string;
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
    return native.database.operation<QuickSearchClickStatRow[]>({
        kind: 'quick_search_find',
        queryNorm,
        limit,
    });
}

/**
 * Return accepted-reference rows by use recency. Unlike typed-query ranking,
 * click frequency is only a deterministic tie-breaker here.
 */
export async function findRecentQuickSearchClicksByQuery({
    queryNorm,
    limit,
}: {
    queryNorm: string;
    limit: number;
}): Promise<QuickSearchRecentClickStatRow[]> {
    return native.database.operation<QuickSearchRecentClickStatRow[]>({
        kind: 'quick_search_find_recent',
        queryNorm,
        limit,
    });
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
    await native.database.operation({
        kind: 'quick_search_upsert',
        queryNorm,
        pathNorm,
        maxClickCount,
    });
}
