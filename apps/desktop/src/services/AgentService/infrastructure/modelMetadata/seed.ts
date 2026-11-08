/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

/**
 * 内置快照种子入口。
 *
 * 快照有 1.6MB 且只在空库兜底时使用，因此单独成入口：
 * 普通 sync / refresh / 设置页展示导入轻量的 `index` 时不会连带解析快照。
 */

import { buildMetadataList } from './catalog';
import snapshotData from './snapshot.json';
import { replaceModelMetadata } from './store';

/**
 * 用内置快照填充本地元数据。
 *
 * 快照随应用发布，本地缓存为空时先落一份兜底数据，
 * 远端不可用也能正常展示模型能力。
 */
export async function seedModelMetadataFromSnapshot(): Promise<void> {
    await replaceModelMetadata(buildMetadataList(snapshotData), { markUpdatedAt: false });
}
