// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelPricing } from '@database/queries/llmMetadata';
import type { AiUsage } from '@services/AgentService/contracts/protocol';

/**
 * 成本明细，金额单位为「微元」（1e-6 货币单位）。
 *
 * 用整数微元而非浮点：SQLite 没有精确小数类型，REAL 是 IEEE754 double，
 * 累加十万条会漂移。opencode 的统计模块用 `cost_microcents` 是同样理由。
 */
export interface CostBreakdown {
    inputCostMicros: number;
    outputCostMicros: number;
    cacheReadCostMicros: number;
    cacheWriteCostMicros: number;
    totalCostMicros: number;
    currency: string;
    pricingModel: string | null;
    /** false 表示无定价，不计入成本合计 */
    priced: boolean;
}

const EMPTY_COST: CostBreakdown = {
    inputCostMicros: 0,
    outputCostMicros: 0,
    cacheReadCostMicros: 0,
    cacheWriteCostMicros: 0,
    totalCostMicros: 0,
    currency: 'USD',
    pricingModel: null,
    priced: false,
};

/**
 * 计算一次调用的成本。
 *
 * 价格单位是「每百万 token」，所以：
 * ```
 * cost = tokens × pricePerMillion / 1e6
 * 微元 = cost × 1e6 = tokens × pricePerMillion
 * ```
 * 即 **微元数 = token 数 × 每百万 token 价格**，无需除法，精度最高。
 *
 * `multiplier` 用于中转站倍率（provider.config_json.cost_multiplier）。
 */
export function computeCost(
    usage: AiUsage,
    pricing: ModelPricing | null,
    multiplier = 1
): CostBreakdown {
    if (!pricing) {
        return EMPTY_COST;
    }

    const inputPrice = Number(pricing.inputPerMillion);
    const outputPrice = Number(pricing.outputPerMillion);
    const cacheReadPrice = Number(pricing.cacheReadPerMillion);
    const cacheWritePrice = Number(pricing.cacheWritePerMillion);

    // 任一价格非法（NaN）时视为无定价，避免算出 NaN 污染合计
    if (
        !Number.isFinite(inputPrice) ||
        !Number.isFinite(outputPrice) ||
        !Number.isFinite(cacheReadPrice) ||
        !Number.isFinite(cacheWritePrice)
    ) {
        return EMPTY_COST;
    }

    const safeMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;

    // 微元 = tokens × 每百万 token 价格 × 倍率，四舍五入到整数微元
    const scale = (tokens: number, price: number) => Math.round(tokens * price * safeMultiplier);

    const inputCostMicros = scale(usage.inputTokens, inputPrice);
    const outputCostMicros = scale(usage.outputTokens, outputPrice);
    const cacheReadCostMicros = scale(usage.cacheReadTokens, cacheReadPrice);
    const cacheWriteCostMicros = scale(usage.cacheWriteTokens, cacheWritePrice);

    return {
        inputCostMicros,
        outputCostMicros,
        cacheReadCostMicros,
        cacheWriteCostMicros,
        totalCostMicros:
            inputCostMicros + outputCostMicros + cacheReadCostMicros + cacheWriteCostMicros,
        currency: pricing.currency,
        pricingModel: pricing.modelId,
        priced: true,
    };
}

/** 累加多个成本明细 */
export function addCostBreakdown(left: CostBreakdown, right: CostBreakdown): CostBreakdown {
    return {
        inputCostMicros: left.inputCostMicros + right.inputCostMicros,
        outputCostMicros: left.outputCostMicros + right.outputCostMicros,
        cacheReadCostMicros: left.cacheReadCostMicros + right.cacheReadCostMicros,
        cacheWriteCostMicros: left.cacheWriteCostMicros + right.cacheWriteCostMicros,
        totalCostMicros: left.totalCostMicros + right.totalCostMicros,
        currency: right.currency || left.currency,
        pricingModel: right.pricingModel ?? left.pricingModel,
        priced: left.priced || right.priced,
    };
}

/** 微元转展示用小数 */
export function microsToAmount(micros: number): number {
    return micros / 1_000_000;
}
