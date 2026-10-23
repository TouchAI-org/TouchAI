// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { addAiUsage, emptyAiUsage } from '@services/AgentService/contracts/protocol';
import { normalizeAiUsage } from '@services/AgentService/infrastructure/providers/ai-sdk/stream';
import type { LanguageModelUsage } from 'ai';
import { describe, expect, it } from 'vitest';

/** 构造一个完整的 LanguageModelUsage，省去测试里的重复字段 */
function usage(partial: Partial<LanguageModelUsage>): LanguageModelUsage {
    return {
        inputTokens: undefined,
        inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
        },
        outputTokens: undefined,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: undefined,
        ...partial,
    } as LanguageModelUsage;
}

describe('user receives token usage from the provider', () => {
    it('user sees the provider normalized input count used when the SDK reports it', () => {
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

    it('user sees fresh input inferred when the provider only reports the total', () => {
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

    it('user never sees a negative fresh-input count', () => {
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

    it('user sees no usage when the provider reports none', () => {
        expect(normalizeAiUsage(undefined)).toBeUndefined();
    });

    it('user sees zeroed counters instead of blanks when every token field is missing', () => {
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

    it('user sees the model name the provider claims it served', () => {
        const result = normalizeAiUsage(
            usage({
                inputTokens: 100,
                outputTokens: 50,
                raw: { model: 'claude-sonnet-4-5-20250929' },
            })
        );

        expect(result?.servedModel).toBe('claude-sonnet-4-5-20250929');
    });

    it('user sees no invented model name when the provider reports none', () => {
        const result = normalizeAiUsage(
            usage({ inputTokens: 100, outputTokens: 50, raw: { other: 1 } })
        );

        expect(result?.servedModel).toBeUndefined();
    });
});

describe('user sees usage accumulated across calls', () => {
    it('user sees every token category added together', () => {
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

    it('user sees the last non-empty served model kept', () => {
        const withModel = { ...emptyAiUsage(), servedModel: 'a' };
        const other = { ...emptyAiUsage(), servedModel: 'b' };

        expect(addAiUsage(withModel, other).servedModel).toBe('b');
        expect(addAiUsage(other, withModel).servedModel).toBe('a');
    });

    it('user sees an empty served model when the provider names none', () => {
        expect(addAiUsage(emptyAiUsage(), emptyAiUsage()).servedModel).toBeUndefined();
    });
});
