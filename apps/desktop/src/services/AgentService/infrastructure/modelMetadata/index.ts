/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import { log } from '@services/ObservabilityService';

import { createTauriFetch } from '../providers/ai-sdk/tauriFetch';
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

/** 涓ゆ杩滅妫€鏌ヤ箣闂寸殑鏈€灏忛棿闅旓紝閬垮厤棰戠箒璁块棶涓婃父銆?*/
export const MODEL_METADATA_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export type ModelMetadataRefreshStatus = 'updated' | 'unchanged' | 'skipped' | 'failed';

export interface ModelMetadataRefreshResult {
    status: ModelMetadataRefreshStatus;
    reason?: string;
}

/**
 * 鍖呰鏉′欢璇锋眰鎵€闇€鐨勮姹傚ご銆? *
 * 璧?Tauri 鍘熺敓 HTTP锛氭祻瑙堝櫒 fetch 鍔?`If-None-Match` 浼氳Е鍙?CORS 棰勬锛? * 鑰屼笂娓镐笉鎺ュ彈 OPTIONS锛堣繑鍥?405锛夛紝鏉′欢璇锋眰鍦?WebView 閲屾棤娉曞畬鎴愩€? */
const metadataFetch = createTauriFetch();

/**
 * 鐢ㄥ唴缃揩鐓у～鍏呮湰鍦板厓鏁版嵁銆? *
 * 蹇収闅忓簲鐢ㄥ彂甯冿紝鏈湴缂撳瓨涓虹┖鏃跺厛钀戒竴浠藉厹搴曟暟鎹紝杩滅涓嶅彲鐢ㄤ篃鑳芥甯稿睍绀烘ā鍨嬭兘鍔涖€? */
export async function seedModelMetadataFromSnapshot(): Promise<void> {
    await replaceModelMetadata(buildMetadataList(snapshotData), { markUpdatedAt: false });
}

/**
 * 浠庤繙绔媺鍙栧苟鍒锋柊鏈湴妯″瀷鍏冩暟鎹€? *
 * 閫氳繃鏉′欢璇锋眰鍒ゆ柇涓婃父鏄惁鍙樺寲锛氬懡涓?304 鏃跺彧鎺ㄨ繘妫€鏌ユ椂闂达紝涓嶉噸鍐欐湰鍦版暟鎹€? */
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
 * 鎸夐渶妫€鏌ヨ繙绔洰褰曪細璺濅笂娆℃鏌ヤ笉瓒抽棿闅旀椂涓嶅彂璧疯姹傘€? *
 * 骞跺彂璋冪敤鍏变韩鍚屼竴娆¤姹傦紝閬垮厤鍚姩娴佺▼涓庤缃〉鍚勬媺涓€閬嶃€? */
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
