// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelPricing, ModelPricingTier } from '@database/queries/llmMetadata';
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
    /** 推理 token 的成本；按推理价单独算，不并进 outputCostMicros */
    reasoningCostMicros: number;
    totalCostMicros: number;
    currency: string;
    pricingModel: string | null;
    /** 实际命中的分级档位（token 数）；未分级为 null */
    appliedTierAbove: number | null;
    /** false 表示无定价，不计入成本合计 */
    priced: boolean;
}

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

/** 一组实际生效的单价 */
interface EffectiveRates {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    tierAbove: number | null;
}

function toRate(value: string, fallback: number): number {
    if (!value) {
        return fallback;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 选出本次请求该用的单价。
 *
 * 分级是「整个请求切档」而不是阶梯计价：请求总输入（含缓存读）一旦超过
 * `above`，全部 token 都按该档价算。这与 OpenAI / Anthropic 的实际计费
 * 方式一致，也是 models.dev `tier.type === 'context'` 的语义。
 *
 * 档位里没给的字段沿用基础价，而不是当作 0。
 */
function resolveRates(
    pricing: ModelPricing,
    promptTokens: number
): { rates: EffectiveRates; valid: boolean } {
    const base: EffectiveRates = {
        input: Number(pricing.inputPerMillion),
        output: Number(pricing.outputPerMillion),
        cacheRead: toRate(pricing.cacheReadPerMillion, 0),
        cacheWrite: toRate(pricing.cacheWritePerMillion, 0),
        reasoning: toRate(pricing.reasoningPerMillion, Number(pricing.outputPerMillion)),
        tierAbove: null,
    };

    // 任一基础价非法时视为无定价，避免算出 NaN 污染合计
    if (!Number.isFinite(base.input) || !Number.isFinite(base.output)) {
        return { rates: base, valid: false };
    }

    // 从高到低找第一个满足的档位
    const tiers: ModelPricingTier[] = pricing.tiers ?? [];
    for (let index = tiers.length - 1; index >= 0; index -= 1) {
        const tier = tiers[index]!;
        if (promptTokens <= tier.above) {
            continue;
        }

        return {
            rates: {
                input: toRate(tier.inputPerMillion, base.input),
                output: toRate(tier.outputPerMillion, base.output),
                cacheRead: toRate(tier.cacheReadPerMillion, base.cacheRead),
                cacheWrite: toRate(tier.cacheWritePerMillion, base.cacheWrite),
                reasoning: toRate(tier.reasoningPerMillion, base.reasoning),
                tierAbove: tier.above,
            },
            valid: true,
        };
    }

    return { rates: base, valid: true };
}

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
 *
 * 注意：`usage.outputTokens` 已包含 `reasoningTokens`。为了避免重复计费，
 * 普通输出按 `output - reasoning` 计，推理部分单独按推理价计。
 */
export function computeCost(
    usage: AiUsage,
    pricing: ModelPricing | null,
    multiplier = 1
): CostBreakdown {
    if (!pricing) {
        return EMPTY_COST;
    }

    // 分级判定用的是请求总输入，缓存命中同样占上下文
    const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    const { rates, valid } = resolveRates(pricing, promptTokens);
    if (!valid) {
        return EMPTY_COST;
    }

    const safeMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;

    // 微元 = tokens × 每百万 token 价格 × 倍率，四舍五入到整数微元
    const scale = (tokens: number, price: number) => Math.round(tokens * price * safeMultiplier);

    // 推理 token 计在 outputTokens 里，先拆出来再分别计价，避免重复计费
    const reasoningTokens = Math.max(0, Math.min(usage.reasoningTokens, usage.outputTokens));
    const textOutputTokens = Math.max(0, usage.outputTokens - reasoningTokens);

    const inputCostMicros = scale(usage.inputTokens, rates.input);
    const outputCostMicros = scale(textOutputTokens, rates.output);
    const cacheReadCostMicros = scale(usage.cacheReadTokens, rates.cacheRead);
    const cacheWriteCostMicros = scale(usage.cacheWriteTokens, rates.cacheWrite);
    const reasoningCostMicros = scale(reasoningTokens, rates.reasoning);

    return {
        inputCostMicros,
        outputCostMicros,
        cacheReadCostMicros,
        cacheWriteCostMicros,
        reasoningCostMicros,
        totalCostMicros:
            inputCostMicros +
            outputCostMicros +
            cacheReadCostMicros +
            cacheWriteCostMicros +
            reasoningCostMicros,
        currency: pricing.currency,
        pricingModel: pricing.modelId,
        appliedTierAbove: rates.tierAbove,
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
        reasoningCostMicros: left.reasoningCostMicros + right.reasoningCostMicros,
        totalCostMicros: left.totalCostMicros + right.totalCostMicros,
        currency: right.currency || left.currency,
        pricingModel: right.pricingModel ?? left.pricingModel,
        // 多次调用可能命中不同档位，累加后不再代表单一档位
        appliedTierAbove:
            left.appliedTierAbove === right.appliedTierAbove ? left.appliedTierAbove : null,
        priced: left.priced || right.priced,
    };
}

/** 微元转展示用小数 */
export function microsToAmount(micros: number): number {
    return micros / 1_000_000;
}
