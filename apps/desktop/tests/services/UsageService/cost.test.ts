// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelPricing } from '@database/queries/llmMetadata';
import type { AiUsage } from '@services/AgentService/contracts/protocol';
import { addCostBreakdown, computeCost, microsToAmount } from '@services/UsageService/cost';
import { describe, expect, it } from 'vitest';

const claudePricing: ModelPricing = {
    modelId: 'claude-sonnet-4-5',
    inputPerMillion: '3',
    outputPerMillion: '15',
    cacheReadPerMillion: '0.3',
    cacheWritePerMillion: '3.75',
    currency: 'USD',
};

function usage(partial: Partial<AiUsage>): AiUsage {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        ...partial,
    };
}

describe('computeCost', () => {
    it('微元 = token 数 × 每百万 token 价格', () => {
        const result = computeCost(usage({ inputTokens: 1_000_000 }), claudePricing);

        // 1M tokens × $3/M = $3 = 3_000_000 微元
        expect(result.inputCostMicros).toBe(3_000_000);
        expect(result.totalCostMicros).toBe(3_000_000);
        expect(result.priced).toBe(true);
    });

    it('四项分别计价后求和', () => {
        const result = computeCost(
            usage({
                inputTokens: 1000,
                outputTokens: 500,
                cacheReadTokens: 2000,
                cacheWriteTokens: 300,
            }),
            claudePricing
        );

        // 1000×3 + 500×15 + 2000×0.3 + 300×3.75 = 3000 + 7500 + 600 + 1125
        expect(result.totalCostMicros).toBe(12225);
    });

    it('推理 token 不重复计价（已含在 outputTokens 内）', () => {
        const withReasoning = computeCost(
            usage({ outputTokens: 1000, reasoningTokens: 500 }),
            claudePricing
        );
        const withoutReasoning = computeCost(usage({ outputTokens: 1000 }), claudePricing);

        expect(withReasoning.totalCostMicros).toBe(withoutReasoning.totalCostMicros);
    });

    it('无定价时 priced=false 且成本为 0', () => {
        const result = computeCost(usage({ inputTokens: 1000, outputTokens: 500 }), null);

        expect(result.priced).toBe(false);
        expect(result.totalCostMicros).toBe(0);
    });

    it('倍率生效', () => {
        const base = computeCost(usage({ inputTokens: 1_000_000 }), claudePricing);
        const doubled = computeCost(usage({ inputTokens: 1_000_000 }), claudePricing, 2);

        expect(doubled.totalCostMicros).toBe(base.totalCostMicros * 2);
    });

    it('非法倍率降级为 1', () => {
        const base = computeCost(usage({ inputTokens: 1_000_000 }), claudePricing);
        const withNan = computeCost(usage({ inputTokens: 1_000_000 }), claudePricing, Number.NaN);
        const withZero = computeCost(usage({ inputTokens: 1_000_000 }), claudePricing, 0);

        expect(withNan.totalCostMicros).toBe(base.totalCostMicros);
        expect(withZero.totalCostMicros).toBe(base.totalCostMicros);
    });

    it('价格非法时降级为无定价，避免 NaN 污染合计', () => {
        const result = computeCost(usage({ inputTokens: 1000 }), {
            ...claudePricing,
            inputPerMillion: 'not-a-number',
        });

        expect(result.priced).toBe(false);
        expect(result.totalCostMicros).toBe(0);
    });

    it('免费模型（0 价）是合法定价，不算未定价', () => {
        const result = computeCost(usage({ inputTokens: 1_000_000 }), {
            ...claudePricing,
            inputPerMillion: '0',
            outputPerMillion: '0',
            cacheReadPerMillion: '0',
            cacheWritePerMillion: '0',
        });

        expect(result.priced).toBe(true);
        expect(result.totalCostMicros).toBe(0);
    });
});

describe('addCostBreakdown', () => {
    it('累加各项成本', () => {
        const left = computeCost(usage({ inputTokens: 1000 }), claudePricing);
        const right = computeCost(usage({ outputTokens: 500 }), claudePricing);
        const total = addCostBreakdown(left, right);

        expect(total.inputCostMicros).toBe(left.inputCostMicros);
        expect(total.outputCostMicros).toBe(right.outputCostMicros);
        expect(total.totalCostMicros).toBe(left.totalCostMicros + right.totalCostMicros);
    });
});

describe('microsToAmount', () => {
    it('微元转小数', () => {
        expect(microsToAmount(3_000_000)).toBe(3);
        expect(microsToAmount(12_345)).toBeCloseTo(0.012345, 6);
    });
});
