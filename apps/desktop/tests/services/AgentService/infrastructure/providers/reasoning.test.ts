import { describe, expect, it } from 'vitest';

import type { AiRequestOptions } from '@/services/AgentService/contracts/protocol';
import {
    DEFAULT_REASONING_LEVEL,
    isReasoningLevel,
    type ReasoningLevel,
} from '@/services/AgentService/contracts/reasoning';
import { OpenAIProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/openai';
import {
    translateDeepSeekReasoningOptions,
    translateMimoReasoningLevel,
    translateOpenAiCompatibleReasoningLevel,
    translateOpenAiReasoningLevel,
} from '@/services/AgentService/infrastructure/providers/reasoning';

describe('reasoning level contract', () => {
    it('accepts only TouchAI canonical reasoning levels', () => {
        expect(isReasoningLevel('none')).toBe(true);
        expect(isReasoningLevel('high')).toBe(true);
        expect(isReasoningLevel('max')).toBe(true);
        expect(isReasoningLevel('bogus')).toBe(false);
        expect(isReasoningLevel(undefined)).toBe(false);
    });

    it('uses max as the temporary default', () => {
        expect(DEFAULT_REASONING_LEVEL).toBe('max');
    });
});

describe('OpenAI reasoning translation', () => {
    it.each([
        ['gpt-5', 'high'],
        ['gpt-5.1', 'high'],
        ['gpt-5.2', 'xhigh'],
        ['gpt-5.4', 'xhigh'],
        ['gpt-5.4-pro', 'xhigh'],
        ['gpt-5.5', 'xhigh'],
        ['gpt-5.6', 'max'],
        ['gpt-6', 'max'],
        ['gpt-6-sol', 'max'],
        ['gpt-6-luna', 'max'],
        ['o3', 'high'],
        ['openai/gpt-6', 'max'],
    ] as const)('clamps the default max level for %s to %s', (modelId, expected) => {
        expect(translateOpenAiReasoningLevel(undefined, modelId)).toBe(expected);
    });

    it('maps an explicitly requested level to the nearest supported model level', () => {
        expect(translateOpenAiReasoningLevel('xhigh', 'gpt-5.1')).toBe('high');
        expect(translateOpenAiReasoningLevel('none', 'gpt-5')).toBe('minimal');
        expect(translateOpenAiReasoningLevel('minimal', 'gpt-5.1')).toBe('low');
        expect(translateOpenAiReasoningLevel('none', 'gpt-5.4-pro')).toBe('medium');
        expect(translateOpenAiReasoningLevel('medium', 'gpt-5.2')).toBe('medium');
    });

    it('uses none for GPT-6 Sol and Luna tool calls on Chat Completions', () => {
        expect(translateOpenAiReasoningLevel('max', 'gpt-6-sol', true)).toBe('none');
        expect(translateOpenAiReasoningLevel('max', 'gpt-6-luna', true)).toBe('none');
        expect(translateOpenAiReasoningLevel('max', 'openai/gpt-6-sol', true)).toBe('none');
        expect(translateOpenAiReasoningLevel('max', 'gpt-6-sol', false)).toBe('max');
        expect(translateOpenAiReasoningLevel('max', 'gpt-6', true)).toBe('max');
    });

    it('passes tool availability from the request into the OpenAI driver translation', () => {
        const adapter = new OpenAIProviderAdapter({
            apiEndpoint: 'https://api.openai.com/v1',
        });
        const probe = adapter as unknown as {
            getStreamProviderOptions(options: AiRequestOptions): unknown;
        };
        const baseOptions: AiRequestOptions = {
            model: 'gpt-6-sol',
            messages: [{ role: 'user', content: 'hello' }],
            reasoningLevel: 'max',
        };

        expect(
            probe.getStreamProviderOptions({
                ...baseOptions,
                tools: [
                    {
                        name: 'test',
                        description: 'test tool',
                        input_schema: { type: 'object', properties: {} },
                    },
                ],
            })
        ).toEqual({ openai: { reasoningEffort: 'none' } });
        expect(probe.getStreamProviderOptions(baseOptions)).toEqual({
            openai: { reasoningEffort: 'max' },
        });
    });

    it('omits the option for unknown or non-reasoning OpenAI models', () => {
        expect(translateOpenAiReasoningLevel(undefined, 'gpt-4o')).toBeUndefined();
        expect(translateOpenAiReasoningLevel(undefined, 'gpt-5-chat-latest')).toBeUndefined();
        expect(translateOpenAiReasoningLevel(undefined, 'unknown-model')).toBeUndefined();
    });
});

describe('OpenAI-compatible reasoning translation', () => {
    it('defaults to max and passes canonical levels through unchanged', () => {
        expect(translateOpenAiCompatibleReasoningLevel(undefined)).toBe('max');
        expect(translateOpenAiCompatibleReasoningLevel('minimal')).toBe('minimal');
        expect(translateOpenAiCompatibleReasoningLevel('xhigh')).toBe('xhigh');
    });
});

describe('DeepSeek reasoning translation', () => {
    it.each([
        ['none', { thinking: { type: 'disabled' } }],
        ['minimal', { reasoningEffort: 'low' }],
        ['low', { reasoningEffort: 'low' }],
        ['medium', { reasoningEffort: 'high' }],
        ['high', { reasoningEffort: 'high' }],
        ['xhigh', { reasoningEffort: 'max' }],
        ['max', { reasoningEffort: 'max' }],
    ] as const)('maps %s to the DeepSeek provider option', (level, expected) => {
        expect(translateDeepSeekReasoningOptions(level)).toEqual(expected);
    });

    it('defaults to max', () => {
        expect(translateDeepSeekReasoningOptions(undefined)).toEqual({ reasoningEffort: 'max' });
    });
});

describe('MiMo reasoning translation', () => {
    it('defaults to max and passes canonical levels through unchanged', () => {
        expect(translateMimoReasoningLevel(undefined)).toBe('max');
        expect(translateMimoReasoningLevel('high')).toBe('high');
    });

    it('keeps the canonical level type intact', () => {
        const level: ReasoningLevel = 'medium';
        expect(translateMimoReasoningLevel(level)).toBe('medium');
    });
});
