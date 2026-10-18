/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import { createTauriFetch } from '@services/AgentService/infrastructure/providers';

import { buildMetadataList } from './catalog';
import snapshotData from './snapshot.json';
import {
    markModelMetadataChecked,
    readModelMetadataLastCheckedAt,
    readModelMetadataSourceEtag,
    replaceModelMetadata,
} from './store';

export { buildMetadataList } from './catalog';
export { persistRefreshedModels } from './refresh';
export { readModelMetadataLastCheckedAt, readModelMetadataSourceEtag } from './store';
export { syncAllModelsMetadata } from './sync';

const MODEL_METADATA_SOURCE_URL = 'https://models.dev/api.json';

/** 两次远端检查之间的最小间隔，避免频繁访问上游。 */
export const MODEL_METADATA_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export type ModelMetadataRefreshStatus = 'updated' | 'unchanged' | 'skipped' | 'failed';

export interface ModelMetadataRefreshResult {
    status: ModelMetadataRefreshStatus;
    reason?: string;
}

/**
 * 包装条件请求所需的请求头。
 *
 * 走 Tauri 原生 HTTP：浏览器 fetch 加 `If-None-Match` 会触发 CORS 预检，
 * 而上游不接受 OPTIONS（返回 405），条件请求在 WebView 里无法完成。
 */
const metadataFetch = createTauriFetch();

/**
 * 用内置快照填充本地元数据。
 *
 * 快照随应用发布，本地缓存为空时先落一份兜底数据，远端不可用也能正常展示模型能力。
 */
export async function seedModelMetadataFromSnapshot(): Promise<void> {
    await replaceModelMetadata(buildMetadataList(snapshotData), { markUpdatedAt: false });
}

/**
 * 从远端拉取并刷新本地模型元数据。
 *
 * 通过条件请求判断上游是否变化：命中 304 时只推进检查时间，不重写本地数据。
 */
export async function updateModelMetadata(): Promise<ModelMetadataRefreshResult> {
    try {
        const previousEtag = await readModelMetadataSourceEtag();

        const response = await metadataFetch(MODEL_METADATA_SOURCE_URL, {
            headers: previousEtag ? { 'If-None-Match': previousEtag } : {},
        });

        if (response.status === 304) {
            await markModelMetadataChecked({
                checkedAt: new Date().toISOString(),
                etag: previousEtag,
            });

            return { status: 'unchanged' };
        }

        if (!response.ok) {
            throw new Error(`Failed to fetch metadata: ${response.statusText}`);
        }

        await replaceModelMetadata(buildMetadataList(await response.json()), {
            markUpdatedAt: true,
            sourceEtag: response.headers.get('etag'),
        });

        return { status: 'updated' };
    } catch (error) {
        console.error('[ModelMetadata] Failed to update metadata:', error);
        throw error;
    }
}

/**
 * 距离上次检查是否已经超过给定间隔。
 *
 * 没有记录时视为需要检查；时间戳不可解析时同样重新检查。
 */
export async function shouldCheckModelMetadata(
    intervalMs: number = MODEL_METADATA_CHECK_INTERVAL_MS
): Promise<boolean> {
    const lastCheckedAt = await readModelMetadataLastCheckedAt();

    if (!lastCheckedAt) {
        return true;
    }

    const lastCheckedTime = Date.parse(lastCheckedAt);
    if (Number.isNaN(lastCheckedTime)) {
        return true;
    }

    return Date.now() - lastCheckedTime >= intervalMs;
}

/** 同一时刻只允许一个远端检查，避免启动流程与设置页重复请求。 */
let inFlightRefresh: Promise<ModelMetadataRefreshResult> | null = null;

/** 读取「是否过期」并完成请求；调用方负责并发去重。 */
async function performStaleRefresh(intervalMs: number): Promise<ModelMetadataRefreshResult> {
    if (!(await shouldCheckModelMetadata(intervalMs))) {
        return { status: 'skipped', reason: 'fresh' };
    }

    return await updateModelMetadata();
}

/**
 * 按需检查远端目录：距上次检查不足间隔时不发起请求。
 *
 * 并发调用共享同一次请求，避免启动流程与设置页各拉一遍。
 */
export async function refreshModelMetadataIfStale(
    intervalMs: number = MODEL_METADATA_CHECK_INTERVAL_MS
): Promise<ModelMetadataRefreshResult> {
    if (inFlightRefresh) {
        return await inFlightRefresh;
    }

    const refresh = performStaleRefresh(intervalMs).finally(() => {
        inFlightRefresh = null;
    });
    inFlightRefresh = refresh;

    return await refresh;
}
