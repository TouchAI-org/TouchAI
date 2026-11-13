// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import type { LlmMetadataCreateData, LlmMetadataEntity } from '../types';

/**
 * 根据 model_id 查询 LLM 元数据
 */
export async function findLlmMetadataByModelId({
    modelId,
}: {
    modelId: string;
}): Promise<LlmMetadataEntity | null> {
    return native.database.operation<LlmMetadataEntity | null>({
        kind: 'llm_metadata_find',
        modelId,
    });
}

/**
 * 批量插入 LLM 元数据
 * 使用 INSERT OR IGNORE 避免重复插入（基于 model_id 的 UNIQUE 约束）
 */
export async function insertLlmMetadata(data: LlmMetadataCreateData[]): Promise<void> {
    if (data.length === 0) return;
    await native.database.operation({
        kind: 'llm_metadata_insert',
        data: data.map((item) => ({ ...item })),
    });
}

/**
 * 清空 LLM 元数据表及其别名
 */
export async function clearLlmMetadata(): Promise<void> {
    await native.database.operation({ kind: 'llm_metadata_clear' });
}

/**
 * 检查 LLM 元数据表是否为空
 */
export async function isLlmMetadataEmpty(): Promise<boolean> {
    return native.database.operation<boolean>({ kind: 'llm_metadata_is_empty' });
}

/**
 * 检查别名表是否为空
 *
 * 旧版本的缓存只有模型记录、没有别名，此时需要重新拉取一次远端目录。
 */
export async function isLlmMetadataAliasEmpty(): Promise<boolean> {
    return native.database.operation<boolean>({ kind: 'llm_metadata_alias_is_empty' });
}

// ==================== 定价 ====================

/** 分级价格：请求总输入超过 `above` 后，整个请求按这组价算 */
export interface ModelPricingTier {
    above: number;
    inputPerMillion: string;
    outputPerMillion: string;
    cacheReadPerMillion: string;
    cacheWritePerMillion: string;
    reasoningPerMillion: string;
}

/** 模型的定价（每百万 token），来自 models.dev */
export interface ModelPricing {
    modelId: string;
    inputPerMillion: string;
    outputPerMillion: string;
    cacheReadPerMillion: string;
    cacheWritePerMillion: string;
    /** 推理 token 单价；等于 output 价时供应商通常不单独给 */
    reasoningPerMillion: string;
    currency: string;
    /** 按上下文长度分级的价格，升序；空数组表示不分级 */
    tiers: ModelPricingTier[];
}

/**
 * 按候选 id 查定价。
 *
 * 复用现有的 `expandModelIdCandidates()`（6 层裁剪，覆盖日期后缀、
 * `-latest`/`-preview`/`-exp`、`auto-`/`any-` 路由前缀），不重复实现归一化。
 *
 * 分两步查：先按 `llm_metadata.model_id` 直接匹配，再通过
 * `llm_metadata_aliases` 把中转写法映射到上游记录。
 * 只查第一张表会漏掉所有只在别名表里存在的写法
 * （例如 `deepseek-v4-1-flash` → `deepseek/deepseek-v4.1-flash`）。
 *
 * 候选按可信度排序（越靠前越可信），取第一个有完整定价的。
 * 必须有 input 与 output 才算有定价——四价齐全原则：缺一项会低估其余调用。
 */
export async function findModelPricing(rawModelId: string): Promise<ModelPricing | null> {
    return native.database.operation<ModelPricing | null>({
        kind: 'llm_metadata_find_pricing',
        modelId: rawModelId,
    });
}

/** 统计已入库的定价条目数（用于设置页展示覆盖情况） */
export async function countPricedModels(): Promise<number> {
    return native.database.operation<number>({ kind: 'llm_metadata_count_priced' });
}
