// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelPricing } from '@database/queries/llmMetadata';
import { addCostBreakdown, computeCost, microsToAmount } from '@services/UsageService/cost';
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

describe('user sees what a request costs', () => {
    it('user sees no price when pricing is unknown', () => {
        const cost = computeCost(usage({ input: 1000 }), null);

        expect(cost.priced).toBe(false);
        expect(cost.totalCostMicros).toBe(0);
    });

    it('user sees tokens priced at the per-million rate', () => {
        const cost = computeCost(usage({ input: 1000, output: 500 }), pricing());

        // 微元 = token 数 × 每百万价
        expect(cost.inputCostMicros).toBe(2000);
        expect(cost.outputCostMicros).toBe(5000);
        expect(cost.totalCostMicros).toBe(7000);
    });

    it('user sees cache reads priced at their own rate', () => {
        const cost = computeCost(usage({ cacheRead: 100_000 }), pricing());

        expect(cost.cacheReadCostMicros).toBe(20_000);
    });

    it('user sees every token category priced and added to the total', () => {
        const cost = computeCost(
            usage({ input: 1000, output: 500, cacheRead: 2000, cacheWrite: 300 }),
            pricing({
                inputPerMillion: '3',
                outputPerMillion: '15',
                cacheReadPerMillion: '0.3',
                cacheWritePerMillion: '3.75',
            })
        );

        // 1000×3 + 500×15 + 2000×0.3 + 300×3.75
        expect(cost.inputCostMicros).toBe(3000);
        expect(cost.outputCostMicros).toBe(7500);
        expect(cost.cacheReadCostMicros).toBe(600);
        expect(cost.cacheWriteCostMicros).toBe(1125);
        expect(cost.totalCostMicros).toBe(12_225);
    });

    it('user sees the relay multiplier applied', () => {
        const cost = computeCost(usage({ input: 1000 }), pricing(), 0.5);

        expect(cost.inputCostMicros).toBe(1000);
    });

    it('user is not overcharged when the relay multiplier is invalid', () => {
        const base = computeCost(usage({ input: 1_000_000 }), pricing({ inputPerMillion: '3' }));

        for (const multiplier of [Number.NaN, 0, -2]) {
            expect(
                computeCost(
                    usage({ input: 1_000_000 }),
                    pricing({ inputPerMillion: '3' }),
                    multiplier
                ).totalCostMicros
            ).toBe(base.totalCostMicros);
        }
    });

    it('user sees unpriced when a base price is not a number', () => {
        const cost = computeCost(usage({ input: 1000 }), pricing({ inputPerMillion: 'abc' }));

        expect(cost.priced).toBe(false);
        expect(cost.totalCostMicros).toBe(0);
    });

    it('user sees a free model priced at zero rather than unknown', () => {
        const cost = computeCost(
            usage({ input: 1_000_000, output: 1_000_000 }),
            pricing({
                inputPerMillion: '0',
                outputPerMillion: '0',
                cacheReadPerMillion: '0',
                cacheWritePerMillion: '0',
                reasoningPerMillion: '0',
            })
        );

        expect(cost.priced).toBe(true);
        expect(cost.totalCostMicros).toBe(0);
    });
});

describe('user sees the cost of a whole conversation', () => {
    it('user sees the per-call costs added together', () => {
        const first = computeCost(usage({ input: 1000 }), pricing());
        const second = computeCost(usage({ output: 500 }), pricing());

        const total = addCostBreakdown(first, second);

        expect(total.inputCostMicros).toBe(first.inputCostMicros);
        expect(total.outputCostMicros).toBe(second.outputCostMicros);
        expect(total.totalCostMicros).toBe(first.totalCostMicros + second.totalCostMicros);
        expect(total.priced).toBe(true);
    });

    it('user does not see a tier claimed when the calls landed in different tiers', () => {
        const tiered = pricing({
            inputPerMillion: '1',
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
        const belowTier = computeCost(usage({ input: 500 }), tiered);
        const aboveTier = computeCost(usage({ input: 5000 }), tiered);

        expect(addCostBreakdown(belowTier, aboveTier).appliedTierAbove).toBeNull();
        expect(addCostBreakdown(aboveTier, aboveTier).appliedTierAbove).toBe(1000);
    });

    it('user reads micro units as a currency amount', () => {
        expect(microsToAmount(3_000_000)).toBe(3);
        expect(microsToAmount(12_345)).toBeCloseTo(0.012345, 6);
    });
});

describe('user sees reasoning priced separately', () => {
    it('user is not charged twice for reasoning already inside the output', () => {
        // output 100 里含 40 推理：60 × 10 + 40 × 10 = 1000，而不是 100 + 400
        const cost = computeCost(
            usage({ output: 100, reasoning: 40 }),
            pricing({ outputPerMillion: '10', reasoningPerMillion: '10' })
        );

        expect(cost.outputCostMicros).toBe(600);
        expect(cost.reasoningCostMicros).toBe(400);
        expect(cost.totalCostMicros).toBe(1000);
    });

    it('user is charged the vendor reasoning price when one is given', () => {
        const cost = computeCost(
            usage({ output: 100, reasoning: 40 }),
            pricing({ outputPerMillion: '10', reasoningPerMillion: '20' })
        );

        expect(cost.outputCostMicros).toBe(600);
        expect(cost.reasoningCostMicros).toBe(800);
        expect(cost.totalCostMicros).toBe(1400);
    });

    it('user is charged nothing for reasoning the vendor prices at zero', () => {
        // 真实情形：kilo/stealth 系列 reasoning = 0
        const cost = computeCost(
            usage({ output: 100, reasoning: 40 }),
            pricing({ outputPerMillion: '20', reasoningPerMillion: '0' })
        );

        expect(cost.outputCostMicros).toBe(1200);
        expect(cost.reasoningCostMicros).toBe(0);
    });

    it('user is never charged for more reasoning than the reported output', () => {
        const cost = computeCost(
            usage({ output: 50, reasoning: 999 }),
            pricing({ outputPerMillion: '10', reasoningPerMillion: '10' })
        );

        // 推理被钳到 50，正文 0，合计仍是 50 × 10
        expect(cost.outputCostMicros).toBe(0);
        expect(cost.reasoningCostMicros).toBe(500);
    });

    it('user sees the output price used when no reasoning price is given', () => {
        const cost = computeCost(
            usage({ output: 100, reasoning: 40 }),
            pricing({ outputPerMillion: '10', reasoningPerMillion: '' })
        );

        expect(cost.reasoningCostMicros).toBe(400);
    });
});

describe('user sees a long conversation priced by context tier', () => {
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

    it('user sees the base price below the tier threshold', () => {
        const cost = computeCost(usage({ input: 100_000, output: 1000 }), tiered);

        expect(cost.inputCostMicros).toBe(200_000);
        expect(cost.appliedTierAbove).toBeNull();
    });

    it('user sees the whole request move to the higher tier once input exceeds it', () => {
        const cost = computeCost(usage({ input: 200_001, output: 1000 }), tiered);

        // 不是「超出部分加价」，而是整个请求切档
        expect(cost.inputCostMicros).toBe(200_001 * 4);
        expect(cost.outputCostMicros).toBe(1000 * 15);
        expect(cost.appliedTierAbove).toBe(200_000);
    });

    it('user sees cached tokens count towards the tier threshold', () => {
        // 新鲜输入很小，但缓存读把总输入推过阈值
        const cost = computeCost(usage({ input: 1000, cacheRead: 250_000 }), tiered);

        expect(cost.appliedTierAbove).toBe(200_000);
        expect(cost.cacheReadCostMicros).toBe(250_000 * 0.4);
    });

    it('user sees the tier boundary treated as exclusive', () => {
        const cost = computeCost(usage({ input: 200_000 }), tiered);

        expect(cost.appliedTierAbove).toBeNull();
    });

    it('user sees the highest matching tier chosen when several are defined', () => {
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

    it('user sees the base price inherited for fields a tier leaves out', () => {
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
