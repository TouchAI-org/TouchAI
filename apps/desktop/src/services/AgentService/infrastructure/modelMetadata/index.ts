/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import { log } from '@services/ObservabilityService';

import { createTauriFetch } from '../providers/ai-sdk/tauriFetch';
import { buildMetadataList } from './catalog';
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

/** 涓ゆ杩滅妫€鏌ヤ箣闂寸殑鏈€灏忛棿闅旓紝閬垮厤棰戠箒璁块棶涓婃父銆?*/
export const MODEL_METADATA_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export type ModelMetadataRefreshStatus = 'updated' | 'unchanged' | 'skipped' | 'failed';

export interface ModelMetadataRefreshResult {
    status: ModelMetadataRefreshStatus;
    reason?: string;
}

/*
 * 条件请求所需的请求头。
 *
 * 走 Tauri 原生 HTTP：浏览器 fetch 加 `If-None-Match` 会触发 CORS 预检，
 * 而上游不接受 OPTIONS（返回 405），条件请求在 WebView 里无法完成。
 */
const metadataFetch = createTauriFetch();

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
        log.error('[ModelMetadata] Failed to update metadata:', error);
        throw error;
    }
}

/**
 * 璺濈涓婃妫€鏌ユ槸鍚﹀凡缁忚秴杩囩粰瀹氶棿闅斻€? *
 * 娌℃湁璁板綍鏃惰涓洪渶瑕佹鏌ワ紱鏃堕棿鎴充笉鍙В鏋愭椂鍚屾牱閲嶆柊妫€鏌ャ€? */
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

/** 鍚屼竴鏃跺埢鍙厑璁镐竴涓繙绔鏌ワ紝閬垮厤鍚姩娴佺▼涓庤缃〉閲嶅璇锋眰銆?*/
let inFlightRefresh: Promise<ModelMetadataRefreshResult> | null = null;

/** 璇诲彇銆屾槸鍚﹁繃鏈熴€嶅苟瀹屾垚璇锋眰锛涜皟鐢ㄦ柟璐熻矗骞跺彂鍘婚噸銆?*/
async function performStaleRefresh(intervalMs: number): Promise<ModelMetadataRefreshResult> {
    if (!(await shouldCheckModelMetadata(intervalMs))) {
        return { status: 'skipped', reason: 'fresh' };
    }

    return await updateModelMetadata();
}

/**
 * 按需检查远端目录：距上次检查不足间隔时不发起请求。
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
