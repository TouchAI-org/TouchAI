/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import { isLlmMetadataAliasEmpty, isLlmMetadataEmpty } from '@database/queries/llmMetadata';
import { replaceModelMetadataCache } from '@database/queries/modelMetadata';
import { getStatistic, setStatistic } from '@database/queries/statistics.ts';
import { type NewLlmMetadata, type NewLlmMetadataAlias, StatisticKey } from '@database/schema.ts';

import { modelMetadataPolicy } from './sync.io';

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

export function readModelMetadataLastUpdatedAt(): Promise<string | null> {
    return getStatistic({ key: StatisticKey.MODEL_METADATA_LAST_UPDATED_AT });
}

export async function isModelMetadataMissing(): Promise<boolean> {
    const [metadataEmpty, aliasesEmpty] = await Promise.all([
        isLlmMetadataEmpty(),
        isLlmMetadataAliasEmpty(),
    ]);
    return metadataEmpty || aliasesEmpty;
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
export function replaceModelMetadata(
    contents: ModelMetadataContents,
    options: { markUpdatedAt: boolean; sourceEtag?: string | null }
): Promise<void> {
    return replaceModelMetadataCache(contents, options, modelMetadataPolicy);
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
    await setStatistic({
        key: StatisticKey.MODEL_METADATA_LAST_CHECKED_AT,
        value: checkedAt,
    });

    if (etag) {
        await setStatistic({
            key: StatisticKey.MODEL_METADATA_SOURCE_ETAG,
            value: etag,
        });
    }
}
