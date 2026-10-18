// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    estimateTokens,
    estimateTokensFromChars,
    parsePromptBreakdown,
    sumFragmentChars,
} from '@utils/promptBreakdown';
import { describe, expect, it } from 'vitest';

describe('estimateTokensFromChars', () => {
    it('returns zero for empty or negative input', () => {
        expect(estimateTokensFromChars(0)).toBe(0);
        expect(estimateTokensFromChars(-10)).toBe(0);
    });

    it('grows monotonically with the character count', () => {
        expect(estimateTokensFromChars(100)).toBeLessThan(estimateTokensFromChars(1000));
    });

    it('estimates more tokens for CJK-heavy text than for latin text', () => {
        // 同样 300 字符，中文占的 token 明显更多
        expect(estimateTokensFromChars(300, 0.9)).toBeGreaterThan(
            estimateTokensFromChars(300, 0.05)
        );
    });

    it('clamps the CJK ratio into 0..1', () => {
        expect(estimateTokensFromChars(300, 5)).toBe(estimateTokensFromChars(300, 1));
        expect(estimateTokensFromChars(300, -5)).toBe(estimateTokensFromChars(300, 0));
    });
});

describe('estimateTokens', () => {
    it('returns zero for an empty string', () => {
        expect(estimateTokens('')).toBe(0);
    });

    it('counts CJK characters as heavier than latin', () => {
        expect(estimateTokens('中文字符')).toBeGreaterThan(estimateTokens('abcd'));
    });
});

describe('parsePromptBreakdown', () => {
    it('returns null for missing input', () => {
        expect(parsePromptBreakdown(null)).toBeNull();
        expect(parsePromptBreakdown('')).toBeNull();
    });

    it('returns null for malformed JSON instead of throwing', () => {
        expect(parsePromptBreakdown('{not json')).toBeNull();
    });

    it('returns null when the fragments field is absent', () => {
        // 没有 fragments 说明这不是分片快照，不能当成「全 0」使用
        expect(parsePromptBreakdown(JSON.stringify({ userPrompt: 10 }))).toBeNull();
    });

    it('fills missing optional fields with zero', () => {
        const parsed = parsePromptBreakdown(JSON.stringify({ fragments: { platform: 100 } }));

        expect(parsed).toEqual({
            fragments: { platform: 100 },
            userPrompt: 0,
            attachments: 0,
            builtinToolDefinitions: 0,
            mcpToolDefinitions: 0,
            systemPromptTotal: 0,
        });
    });
});

describe('sumFragmentChars', () => {
    it('sums every fragment source', () => {
        expect(sumFragmentChars({ platform: 10, policy: 25, mode: 5 })).toBe(40);
    });

    it('returns zero for an empty map', () => {
        expect(sumFragmentChars({})).toBe(0);
    });
});
