// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { findModelPricing, type ModelPricing } from '@database/queries/llmMetadata';
import type { AiCallRecord, AiUsage } from '@services/AgentService/contracts/protocol';

import type { PersistedCall } from './callParts';
import { addCostBreakdown, computeCost, type CostBreakdown } from './cost';

export type { PersistedCall } from './callParts';
export { buildLlmCallPartData, type LlmCallPartData } from './callParts';
export { insertLlmCallParts } from './insertLlmCallParts';

/** 空成本，作为累加初值 */
const EMPTY_COST: CostBreakdown = {
    inputCostMicros: 0,
    outputCostMicros: 0,
    cacheReadCostMicros: 0,
    cacheWriteCostMicros: 0,
    reasoningCostMicros: 0,
    totalCostMicros: 0,
    currency: 'USD',
    pricingModel: null,
    appliedTierAbove: null,
    priced: false,
};

/**
 * 把一组 LLM 调用记录转换为可落库的形态（含成本计算）。
 *
 * 成本在这里算一次，落库后不再重算——保证历史数据的价格是「当时的快照」，
 * models.dev 后续改价不影响已发生的调用。
 */
export async function resolveCalls(
    calls: ReadonlyArray<AiCallRecord>,
    multiplier = 1
): Promise<PersistedCall[]> {
    const persisted: PersistedCall[] = [];

    // 同一次 attempt 内多次调用常是同一模型，避免重复查库
    const pricingCache = new Map<string, ModelPricing | null>();

    for (const record of calls) {
        let pricing = pricingCache.get(record.modelName);
        if (pricing === undefined) {
            pricing = await findModelPricing(record.modelName);
            pricingCache.set(record.modelName, pricing);
        }
        persisted.push({ record, cost: computeCost(record.usage, pricing, multiplier) });
    }

    return persisted;
}

/** 累加多个调用的用量 */
export function sumUsage(calls: ReadonlyArray<PersistedCall>): AiUsage {
    return calls.reduce<AiUsage>(
        (accumulated, item) => ({
            inputTokens: accumulated.inputTokens + item.record.usage.inputTokens,
            outputTokens: accumulated.outputTokens + item.record.usage.outputTokens,
            cacheReadTokens: accumulated.cacheReadTokens + item.record.usage.cacheReadTokens,
            cacheWriteTokens: accumulated.cacheWriteTokens + item.record.usage.cacheWriteTokens,
            reasoningTokens: accumulated.reasoningTokens + item.record.usage.reasoningTokens,
        }),
        {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        }
    );
}

/** 累加多个调用的成本 */
export function sumCost(calls: ReadonlyArray<PersistedCall>): CostBreakdown {
    return calls.reduce<CostBreakdown>(
        (accumulated, item) => addCostBreakdown(accumulated, item.cost),
        EMPTY_COST
    );
}

/** 无定价的调用数（这些调用不计入成本合计） */
export function countUnpriced(calls: ReadonlyArray<PersistedCall>): number {
    return calls.filter((item) => !item.cost.priced).length;
}
