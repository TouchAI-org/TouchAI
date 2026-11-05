/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import { StatisticKey } from '@database/keys';
import { getStatistic } from '@database/queries/statistics.ts';
import { type NewLlmMetadata, type NewLlmMetadataAlias } from '@database/schema.ts';
import { native } from '@services/NativeService';

export interface ModelMetadataContents {
    metadataList: NewLlmMetadata[];
    aliasList: NewLlmMetadataAlias[];
}

/**
 * 读取上次成功检查远端目录的时间。
 */
export async function readModelMetadataLastCheckedAt(): Promise<string | null> {
    return await getStatistic({ key: StatisticKey.MODEL_METADATA_LAST_CHECKED_AT });
}

/**
 * 读取上次成功检查时上游返回的 ETag，用于条件请求。
 */
export async function readModelMetadataSourceEtag(): Promise<string | null> {
    return await getStatistic({ key: StatisticKey.MODEL_METADATA_SOURCE_ETAG });
}

/**
 * 用给定列表整体替换本地元数据，并同步到运行时模型行。
 *
 * 调用方必须先保证列表非空，否则会清空本地缓存。
 */
export async function replaceModelMetadata(
    { metadataList, aliasList }: ModelMetadataContents,
    {
        sourceEtag = null,
        markUpdatedAt,
    }: {
        markUpdatedAt: boolean;
        sourceEtag?: string | null;
    }
): Promise<void> {
    await native.database.operation({
        kind: 'llm_metadata_replace',
        metadata: metadataList.map((item) => ({ ...item })),
        aliases: aliasList.map((item) => ({ ...item })),
        markUpdatedAt,
        sourceEtag,
    });
}

/**
 * 记录一次未产生新内容的成功检查。
 *
 * 命中 304 时也要推进检查时间，避免短期内重复请求上游。
 */
export async function markModelMetadataChecked({
    checkedAt,
    etag,
}: {
    checkedAt: string;
    etag: string | null;
}): Promise<void> {
    await native.database.operation({
        kind: 'llm_metadata_mark_checked',
        checkedAt,
        etag,
    });
}
