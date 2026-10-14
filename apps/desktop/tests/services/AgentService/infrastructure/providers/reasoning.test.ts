import { describe, expect, it } from 'vitest';

import { isReasoningEffort } from '@/services/AgentService/contracts/reasoning';
import {
    buildReasoningProviderOptions,
    getDefaultReasoningEffort,
    getProviderReasoningCapabilities,
    resolveReasoningEffort,
} from '@/services/AgentService/infrastructure/providers/reasoning';

describe('reasoning effort contracts', () => {
    it('accepts only canonical effort values', () => {
        expect(isReasoningEffort('high')).toBe(true);
        expect(isReasoningEffort('max')).toBe(true);
        expect(isReasoningEffort('bogus')).toBe(false);
        expect(isReasoningEffort(undefined)).toBe(false);
    });
});

describe('provider reasoning capabilities', () => {
    it.each([
        ['openai', 'xhigh'],
        ['openai-compatible', 'max'],
        ['deepseek', 'max'],
        ['mimo', 'max'],
    ] as const)('uses the highest supported effort for %s', (driver, expected) => {
        expect(getDefaultReasoningEffort(driver)).toBe(expected);
    });

    it('does not claim reasoning support for unrelated drivers', () => {
        expect(getProviderReasoningCapabilities('anthropic').supportsReasoning).toBe(false);
        expect(getDefaultReasoningEffort('anthropic')).toBeUndefined();
    });

    it('accepts a supported requested effort', () => {
        expect(resolveReasoningEffort('openai', 'medium')).toBe('medium');
        expect(resolveReasoningEffort('deepseek', 'high')).toBe('high');
    });

    it('falls back to the highest supported effort instead of forwarding invalid values', () => {
        expect(resolveReasoningEffort('openai', 'bogus')).toBe('xhigh');
        expect(resolveReasoningEffort('deepseek', 'none')).toBe('max');
        expect(resolveReasoningEffort('openai-compatible', undefined)).toBe('max');
    });

    it('resolves the highest supported effort for known OpenAI models', () => {
        expect(resolveReasoningEffort('openai', undefined, 'gpt-5')).toBe('high');
        expect(resolveReasoningEffort('openai', undefined, 'gpt-5.1')).toBe('high');
        expect(resolveReasoningEffort('openai', undefined, 'gpt-5.2')).toBe('xhigh');
        expect(resolveReasoningEffort('openai', undefined, 'gpt-5.4-pro')).toBe('xhigh');
        expect(resolveReasoningEffort('openai', undefined, 'gpt-5.6')).toBe('max');
        expect(resolveReasoningEffort('openai', undefined, 'openai/gpt-6')).toBe('max');
    });

    it('omits effort for unknown or non-reasoning OpenAI models', () => {
        expect(resolveReasoningEffort('openai', undefined, 'gpt-4o')).toBeUndefined();
        expect(resolveReasoningEffort('openai', undefined, 'gpt-5-chat-latest')).toBeUndefined();
    });

    it('falls back to the model-specific highest effort when requested is unsupported', () => {
        expect(resolveReasoningEffort('openai', 'xhigh', 'gpt-5.1')).toBe('high');
        expect(resolveReasoningEffort('openai', 'none', 'gpt-5')).toBe('high');
    });

    it('returns undefined when the provider driver is missing', () => {
        expect(resolveReasoningEffort(undefined)).toBeUndefined();
    });
});

describe('provider reasoning option translation', () => {
    it.each([
        ['openai', 'high', { openai: { reasoningEffort: 'high' } }],
        ['openai-compatible', 'max', { 'openai-compatible': { reasoningEffort: 'max' } }],
        ['deepseek', 'max', { deepseek: { reasoningEffort: 'max' } }],
        ['mimo', 'high', { mimo: { reasoningEffort: 'high' } }],
    ] as const)(
        'translates %s effort into its SDK providerOptions key',
        (driver, effort, expected) => {
            expect(buildReasoningProviderOptions(driver, effort)).toEqual(expected);
        }
    );

    it('uses model-aware OpenAI effort in providerOptions', () => {
        expect(buildReasoningProviderOptions('openai', undefined, 'gpt-5.1')).toEqual({
            openai: { reasoningEffort: 'high' },
        });
        expect(buildReasoningProviderOptions('openai', undefined, 'gpt-5.6')).toEqual({
            openai: { reasoningEffort: 'max' },
        });
        expect(buildReasoningProviderOptions('openai', undefined, 'gpt-4o')).toBeUndefined();
    });

    it('never forwards an invalid value to providerOptions', () => {
        expect(buildReasoningProviderOptions('openai-compatible', 'bogus')).toEqual({
            'openai-compatible': { reasoningEffort: 'max' },
        });
    });

    it('returns undefined for drivers without an effort transport', () => {
        expect(buildReasoningProviderOptions('anthropic', 'high')).toBeUndefined();
    });

    it('returns undefined when the provider driver is missing', () => {
        expect(buildReasoningProviderOptions(undefined, 'high')).toBeUndefined();
    });
});
