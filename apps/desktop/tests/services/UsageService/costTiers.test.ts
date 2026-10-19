// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelPricing } from '@database/queries/llmMetadata';
import { computeCost } from '@services/UsageService/cost';
import { describe, expect, it } from 'vitest';

function pricing(partial: Partial<ModelPricing> = {}): ModelPricing {
    return {
        modelId: 'test/model',
        inputPerMillion: '2',
        outputPerMillion: '10',
        cacheReadPerMillion: '0.2',
        cacheWritePerMillion: '2.5',
        reasoningPerMillion: '10',
        currency: 'USD',
        tiers: [],
        ...partial,
    };
}

function usage(
    partial: Partial<{
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        reasoning: number;
    }> = {}
) {
    return {
        inputTokens: partial.input ?? 0,
        outputTokens: partial.output ?? 0,
        cacheReadTokens: partial.cacheRead ?? 0,
        cacheWriteTokens: partial.cacheWrite ?? 0,
        reasoningTokens: partial.reasoning ?? 0,
    };
}

describe('computeCost basics', () => {
    it('returns an unpriced breakdown when no pricing is known', () => {
        const cost = computeCost(usage({ input: 1000 }), null);

        expect(cost.priced).toBe(false);
        expect(cost.totalCostMicros).toBe(0);
    });

    it('multiplies tokens by the per-million price to get micro units', () => {
        const cost = computeCost(usage({ input: 1000, output: 500 }), pricing());

        // 微元 = token 数 × 每百万价
        expect(cost.inputCostMicros).toBe(2000);
        expect(cost.outputCostMicros).toBe(5000);
        expect(cost.totalCostMicros).toBe(7000);
    });

    it('charges cache reads at their own price', () => {
        const cost = computeCost(usage({ cacheRead: 100_000 }), pricing());

        expect(cost.cacheReadCostMicros).toBe(20_000);
    });

    it('applies the relay multiplier', () => {
        const cost = computeCost(usage({ input: 1000 }), pricing(), 0.5);

        expect(cost.inputCostMicros).toBe(1000);
    });

    it('falls back to unpriced when a base price is not a number', () => {
        const cost = computeCost(usage({ input: 1000 }), pricing({ inputPerMillion: 'abc' }));

        expect(cost.priced).toBe(false);
    });
});

describe('reasoning tokens', () => {
    it('does not double-charge reasoning tokens that are already inside output', () => {
        // output 100 里含 40 推理：60 × 10 + 40 × 10 = 1000，而不是 100 + 400
        const cost = computeCost(
            usage({ output: 100, reasoning: 40 }),
            pricing({ outputPerMillion: '10', reasoningPerMillion: '10' })
        );

        expect(cost.outputCostMicros).toBe(600);
        expect(cost.reasoningCostMicros).toBe(400);
        expect(cost.totalCostMicros).toBe(1000);
    });

    it('charges a different reasoning price when the vendor gives one', () => {
        const cost = computeCost(
            usage({ output: 100, reasoning: 40 }),
            pricing({ outputPerMillion: '10', reasoningPerMillion: '20' })
        );

        expect(cost.outputCostMicros).toBe(600);
        expect(cost.reasoningCostMicros).toBe(800);
        expect(cost.totalCostMicros).toBe(1400);
    });

    it('charges nothing for reasoning when the vendor prices it at zero', () => {
        // 真实情形：kilo/stealth 系列 reasoning = 0
        const cost = computeCost(
            usage({ output: 100, reasoning: 40 }),
            pricing({ outputPerMillion: '20', reasoningPerMillion: '0' })
        );

        expect(cost.outputCostMicros).toBe(1200);
        expect(cost.reasoningCostMicros).toBe(0);
    });

    it('never counts more reasoning than the reported output', () => {
        const cost = computeCost(
            usage({ output: 50, reasoning: 999 }),
            pricing({ outputPerMillion: '10', reasoningPerMillion: '10' })
        );

        // 推理被钳到 50，正文 0，合计仍是 50 × 10
        expect(cost.outputCostMicros).toBe(0);
        expect(cost.reasoningCostMicros).toBe(500);
    });

    it('falls back to the output price when no reasoning price is given', () => {
        const cost = computeCost(
            usage({ output: 100, reasoning: 40 }),
            pricing({ outputPerMillion: '10', reasoningPerMillion: '' })
        );

        expect(cost.reasoningCostMicros).toBe(400);
    });
});

describe('context tiers', () => {
    const tiered = pricing({
        inputPerMillion: '2',
        outputPerMillion: '10',
        cacheReadPerMillion: '0.2',
        tiers: [
            {
                above: 200_000,
                inputPerMillion: '4',
                outputPerMillion: '15',
                cacheReadPerMillion: '0.4',
                cacheWritePerMillion: '5',
                reasoningPerMillion: '15',
            },
        ],
    });

    it('uses the base price below the threshold', () => {
        const cost = computeCost(usage({ input: 100_000, output: 1000 }), tiered);

        expect(cost.inputCostMicros).toBe(200_000);
        expect(cost.appliedTierAbove).toBeNull();
    });

    it('switches the whole request to the higher tier once input exceeds it', () => {
        const cost = computeCost(usage({ input: 200_001, output: 1000 }), tiered);

        // 不是「超出部分加价」，而是整个请求切档
        expect(cost.inputCostMicros).toBe(200_001 * 4);
        expect(cost.outputCostMicros).toBe(1000 * 15);
        expect(cost.appliedTierAbove).toBe(200_000);
    });

    it('counts cached tokens towards the tier threshold', () => {
        // 新鲜输入很小，但缓存读把总输入推过阈值
        const cost = computeCost(usage({ input: 1000, cacheRead: 250_000 }), tiered);

        expect(cost.appliedTierAbove).toBe(200_000);
        expect(cost.cacheReadCostMicros).toBe(250_000 * 0.4);
    });

    it('treats the boundary as exclusive', () => {
        const cost = computeCost(usage({ input: 200_000 }), tiered);

        expect(cost.appliedTierAbove).toBeNull();
    });

    it('picks the highest matching tier when several are defined', () => {
        const multi = pricing({
            inputPerMillion: '1',
            tiers: [
                {
                    above: 32_000,
                    inputPerMillion: '2',
                    outputPerMillion: '',
                    cacheReadPerMillion: '',
                    cacheWritePerMillion: '',
                    reasoningPerMillion: '',
                },
                {
                    above: 128_000,
                    inputPerMillion: '3',
                    outputPerMillion: '',
                    cacheReadPerMillion: '',
                    cacheWritePerMillion: '',
                    reasoningPerMillion: '',
                },
            ],
        });

        expect(computeCost(usage({ input: 50_000 }), multi).appliedTierAbove).toBe(32_000);
        expect(computeCost(usage({ input: 200_000 }), multi).appliedTierAbove).toBe(128_000);
        expect(computeCost(usage({ input: 200_000 }), multi).inputCostMicros).toBe(200_000 * 3);
    });

    it('inherits the base price for fields the tier leaves out', () => {
        const partial = pricing({
            inputPerMillion: '1',
            outputPerMillion: '10',
            tiers: [
                {
                    above: 1000,
                    inputPerMillion: '2',
                    outputPerMillion: '',
                    cacheReadPerMillion: '',
                    cacheWritePerMillion: '',
                    reasoningPerMillion: '',
                },
            ],
        });

        const cost = computeCost(usage({ input: 2000, output: 100 }), partial);

        expect(cost.inputCostMicros).toBe(4000);
        // 档位没给 output 价，沿用基础价 10 而不是 0
        expect(cost.outputCostMicros).toBe(1000);
    });
});
