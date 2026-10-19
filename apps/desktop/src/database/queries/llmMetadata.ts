// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { expandModelIdCandidates } from '@services/AgentService/infrastructure/modelMetadata/modelIdCandidates';
import { and, count, eq, inArray, isNotNull } from 'drizzle-orm';

import { db } from '../index';
import { llmMetadata, llmMetadataAliases } from '../schema';
import type { LlmMetadataCreateData, LlmMetadataEntity } from '../types';

/**
 * 根据 model_id 查询 LLM 元数据
 */
export async function findLlmMetadataByModelId({
    modelId,
}: {
    modelId: string;
}): Promise<LlmMetadataEntity | null> {
    const result = await db
        .select()
        .from(llmMetadata)
        .where(eq(llmMetadata.model_id, modelId))
        .get();

    return result || null;
}

/**
 * 批量插入 LLM 元数据
 * 使用 INSERT OR IGNORE 避免重复插入（基于 model_id 的 UNIQUE 约束）
 */
export async function insertLlmMetadata(data: LlmMetadataCreateData[]): Promise<void> {
    if (data.length === 0) return;

    await db
        .insert(llmMetadata)
        .values(data)
        .onConflictDoNothing({ target: llmMetadata.model_id })
        .run();
}

/**
 * 清空 LLM 元数据表及其别名
 */
export async function clearLlmMetadata(): Promise<void> {
    await db.delete(llmMetadataAliases).run();
    await db.delete(llmMetadata).run();
}

/**
 * 检查 LLM 元数据表是否为空
 */
export async function isLlmMetadataEmpty(): Promise<boolean> {
    const result = await db.select({ count: count() }).from(llmMetadata).get();

    return (result?.count ?? 0) === 0;
}

/**
 * 检查别名表是否为空
 *
 * 旧版本的缓存只有模型记录、没有别名，此时需要重新拉取一次远端目录。
 */
export async function isLlmMetadataAliasEmpty(): Promise<boolean> {
    const result = await db.select({ count: count() }).from(llmMetadataAliases).get();

    return (result?.count ?? 0) === 0;
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

/** 解析入库的分级 JSON，容错返回空数组 */
function parseCostTiers(raw: string | null): ModelPricingTier[] {
    if (!raw) {
        return [];
    }

    try {
        const parsed = JSON.parse(raw) as Array<{
            above: number;
            input: number | null;
            output: number | null;
            cacheRead: number | null;
            cacheWrite: number | null;
            reasoning: number | null;
        }>;
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed
            .filter((tier) => typeof tier.above === 'number' && tier.above > 0)
            .sort((left, right) => left.above - right.above)
            .map((tier) => ({
                above: tier.above,
                // 档位未给价时沿用基础价，传空串让调用方回退
                inputPerMillion: tier.input?.toString() ?? '',
                outputPerMillion: tier.output?.toString() ?? '',
                cacheReadPerMillion: tier.cacheRead?.toString() ?? '',
                cacheWritePerMillion: tier.cacheWrite?.toString() ?? '',
                reasoningPerMillion: tier.reasoning?.toString() ?? '',
            }));
    } catch {
        return [];
    }
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
    const candidates = expandModelIdCandidates(rawModelId).map((item) => item.candidate);
    if (candidates.length === 0) {
        return null;
    }

    const aliasRows = await db
        .select({ alias: llmMetadataAliases.alias, modelId: llmMetadataAliases.model_id })
        .from(llmMetadataAliases)
        .where(inArray(llmMetadataAliases.alias, candidates))
        .all();

    // 直接命中的优先级高于别名命中：模型 id 本身就在目录里时不需要绕路
    const lookupOrder = [...candidates, ...aliasRows.map((row) => row.modelId)].filter(
        (value, index, list) => list.indexOf(value) === index
    );

    const rows = await db
        .select({
            modelId: llmMetadata.model_id,
            input: llmMetadata.input_cost_per_million,
            output: llmMetadata.output_cost_per_million,
            cacheRead: llmMetadata.cache_read_cost_per_million,
            cacheWrite: llmMetadata.cache_write_cost_per_million,
            reasoning: llmMetadata.reasoning_cost_per_million,
            currency: llmMetadata.cost_currency,
            tiers: llmMetadata.cost_tiers,
        })
        .from(llmMetadata)
        .where(inArray(llmMetadata.model_id, lookupOrder))
        .all();

    const priced = rows.filter((row) => row.input !== null && row.output !== null);
    if (priced.length === 0) {
        return null;
    }

    const rank = new Map(lookupOrder.map((id, index) => [id, index]));
    priced.sort(
        (left, right) =>
            (rank.get(left.modelId) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(right.modelId) ?? Number.MAX_SAFE_INTEGER)
    );

    const best = priced[0]!;
    return {
        modelId: best.modelId,
        inputPerMillion: best.input!,
        outputPerMillion: best.output!,
        cacheReadPerMillion: best.cacheRead ?? '0',
        cacheWritePerMillion: best.cacheWrite ?? '0',
        // 供应商不单独报推理价时，推理 token 按 output 价计
        reasoningPerMillion: best.reasoning ?? best.output!,
        currency: best.currency ?? 'USD',
        tiers: parseCostTiers(best.tiers),
    };
}

/** 统计已入库的定价条目数（用于设置页展示覆盖情况） */
export async function countPricedModels(): Promise<number> {
    const result = await db
        .select({ count: count() })
        .from(llmMetadata)
        .where(
            and(
                isNotNull(llmMetadata.input_cost_per_million),
                isNotNull(llmMetadata.output_cost_per_million)
            )
        )
        .get();

    return result?.count ?? 0;
}
