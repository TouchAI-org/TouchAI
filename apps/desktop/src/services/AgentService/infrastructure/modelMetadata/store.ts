/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import { db } from '@database';
import { getStatistic, setStatistic } from '@database/queries/statistics.ts';
import {
    llmMetadata,
    llmMetadataAliases,
    type NewLlmMetadata,
    type NewLlmMetadataAlias,
    StatisticKey,
} from '@database/schema.ts';

import { syncAllModelsMetadata } from './sync';

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
    await db.transaction(async (tx) => {
        await tx.delete(llmMetadataAliases).run();
        await tx.delete(llmMetadata).run();

        await tx
            .insert(llmMetadata)
            .values(metadataList)
            .onConflictDoNothing({ target: llmMetadata.model_id })
            .run();

        if (aliasList.length > 0) {
            await tx
                .insert(llmMetadataAliases)
                .values(aliasList)
                .onConflictDoNothing({ target: llmMetadataAliases.alias })
                .run();
        }

        await syncAllModelsMetadata(tx);

        if (markUpdatedAt) {
            const now = new Date().toISOString();

            await setStatistic({
                key: StatisticKey.MODEL_METADATA_LAST_UPDATED_AT,
                value: now,
                database: tx,
            });
            await setStatistic({
                key: StatisticKey.MODEL_METADATA_LAST_CHECKED_AT,
                value: now,
                database: tx,
            });

            if (sourceEtag) {
                await setStatistic({
                    key: StatisticKey.MODEL_METADATA_SOURCE_ETAG,
                    value: sourceEtag,
                    database: tx,
                });
            }
        }
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
