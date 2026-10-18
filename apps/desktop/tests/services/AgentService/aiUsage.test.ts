// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { addAiUsage, emptyAiUsage } from '@services/AgentService/contracts/protocol';
import { normalizeAiUsage } from '@services/AgentService/infrastructure/providers/ai-sdk/stream';
import type { LanguageModelUsage } from 'ai';
import { describe, expect, it } from 'vitest';

/** 构造一个完整的 LanguageModelUsage，省去测试里的重复字段 */
function usage(partial: Partial<LanguageModelUsage>): LanguageModelUsage {
    return {
        inputTokens: undefined,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokens: undefined,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: undefined,
        ...partial,
    } as LanguageModelUsage;
}

describe('normalizeAiUsage', () => {
    it('优先使用 SDK 归一的 noCacheTokens', () => {
        const result = normalizeAiUsage(
            usage({
                inputTokens: 2000,
                inputTokenDetails: {
                    noCacheTokens: 1200,
                    cacheReadTokens: 800,
                    cacheWriteTokens: 0,
                },
                outputTokens: 350,
                outputTokenDetails: { textTokens: 230, reasoningTokens: 120 },
                totalTokens: 2350,
            })
        );

        expect(result).toMatchObject({
            inputTokens: 1200,
            outputTokens: 350,
            cacheReadTokens: 800,
            cacheWriteTokens: 0,
            reasoningTokens: 120,
        });
    });

    it('noCacheTokens 缺失时反推新鲜输入', () => {
        const result = normalizeAiUsage(
            usage({
                inputTokens: 2000,
                inputTokenDetails: {
                    noCacheTokens: undefined,
                    cacheReadTokens: 800,
                    cacheWriteTokens: 200,
                },
                outputTokens: 100,
                totalTokens: 2100,
            })
        );

        expect(result?.inputTokens).toBe(1000);
    });

    it('反推为负时钳到 0（部分中转把 prompt_tokens 当新鲜输入报）', () => {
        const result = normalizeAiUsage(
            usage({
                inputTokens: 500,
                inputTokenDetails: {
                    noCacheTokens: undefined,
                    cacheReadTokens: 800,
                    cacheWriteTokens: 0,
                },
                outputTokens: 100,
                totalTokens: 600,
            })
        );

        expect(result?.inputTokens).toBe(0);
    });

    it('usage 为 undefined 时返回 undefined', () => {
        expect(normalizeAiUsage(undefined)).toBeUndefined();
    });

    it('完全缺失 token 字段时全部为 0，而不是 undefined', () => {
        const result = normalizeAiUsage(usage({}));

        expect(result).toEqual({
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            servedModel: undefined,
            raw: undefined,
        });
    });

    it('从 raw 提取供应商自称的模型名', () => {
        const result = normalizeAiUsage(
            usage({
                inputTokens: 100,
                outputTokens: 50,
                raw: { model: 'claude-sonnet-4-5-20250929' },
            })
        );

        expect(result?.servedModel).toBe('claude-sonnet-4-5-20250929');
    });

    it('raw 无模型名时不编造', () => {
        const result = normalizeAiUsage(
            usage({ inputTokens: 100, outputTokens: 50, raw: { other: 1 } })
        );

        expect(result?.servedModel).toBeUndefined();
    });
});

describe('addAiUsage', () => {
    it('累加所有 token 分类', () => {
        const left = {
            ...emptyAiUsage(),
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            reasoningTokens: 20,
        };
        const right = {
            ...emptyAiUsage(),
            inputTokens: 200,
            outputTokens: 80,
            cacheReadTokens: 30,
            cacheWriteTokens: 15,
            reasoningTokens: 40,
        };

        expect(addAiUsage(left, right)).toMatchObject({
            inputTokens: 300,
            outputTokens: 130,
            cacheReadTokens: 40,
            cacheWriteTokens: 20,
            reasoningTokens: 60,
        });
    });

    it('servedModel 取非空值', () => {
        const withModel = { ...emptyAiUsage(), servedModel: 'a' };
        const other = { ...emptyAiUsage(), servedModel: 'b' };

        expect(addAiUsage(withModel, other).servedModel).toBe('b');
        expect(addAiUsage(other, withModel).servedModel).toBe('a');
    });

    it('servedModel 都为空时保持为空', () => {
        expect(addAiUsage(emptyAiUsage(), emptyAiUsage()).servedModel).toBeUndefined();
    });
});
