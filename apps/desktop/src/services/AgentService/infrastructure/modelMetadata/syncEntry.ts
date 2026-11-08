/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

/**
 * 模型元数据的「轻」入口。
 *
 * 启动阶段用动态 import 加载它：只包含同步/刷新函数，不含 1.6MB 的内置快照
 * （快照只在空库兜底时经 `seed.ts` 解析）。
 */

export {
    refreshModelMetadataIfStale,
    shouldCheckModelMetadata,
    updateModelMetadata,
} from './index';
export { syncAllModelsMetadata } from './sync';
