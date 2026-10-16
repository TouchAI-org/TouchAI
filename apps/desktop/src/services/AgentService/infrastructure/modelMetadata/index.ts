/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import { buildMetadataList } from './catalog';
import snapshotData from './snapshot.json';
import { replaceModelMetadata } from './store';

export { buildMetadataList } from './catalog';

const MODEL_METADATA_SOURCE_URL = 'https://models.dev/api.json';

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
 */
export async function updateModelMetadata(): Promise<void> {
    try {
        const response = await fetch(MODEL_METADATA_SOURCE_URL);
        if (!response.ok) {
            throw new Error(`Failed to fetch metadata: ${response.statusText}`);
        }

        await replaceModelMetadata(buildMetadataList(await response.json()), {
            markUpdatedAt: true,
        });
    } catch (error) {
        console.error('[ModelMetadata] Failed to update metadata:', error);
        throw error;
    }
}
