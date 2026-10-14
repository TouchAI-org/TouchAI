import { describe, expect, it } from 'vitest';

import type { AiRequestOptions } from '@/services/AgentService/contracts/protocol';
import {
    DEFAULT_REASONING_LEVEL,
    isReasoningLevel,
    normalizeReasoningOptions,
    type ReasoningLevel,
    type ReasoningOption,
} from '@/services/AgentService/contracts/reasoning';
import { OpenAICompatibleProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/openai-compatible';
import { OpenAIProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/openai';
import {
    encodeReasoning,
    resolveReasoning,
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

    it('defaults the official driver to the stateless Responses protocol', () => {
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

        expect(probe.getStreamProviderOptions(baseOptions)).toEqual({
            openai: {
                store: false,
                reasoningSummary: 'auto',
                include: ['reasoning.encrypted_content'],
                reasoningEffort: 'max',
            },
        });
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
        ).toEqual({
            openai: {
                store: false,
                reasoningSummary: 'auto',
                include: ['reasoning.encrypted_content'],
                reasoningEffort: 'max',
            },
        });
    });

    it('uses Chat Completions transport for non-Responses protocol overrides', () => {
        const adapter = new OpenAIProviderAdapter({
            apiEndpoint: 'https://api.openai.com/v1',
            config: { reasoning: { protocol: 'deepseek-chat' } },
        });

        expect(adapter.getApiTargets().generationTarget).toBe(
            'https://api.openai.com/v1/chat/completions'
        );
    });
    it('keeps the Chat Completions constraint when the protocol is overridden', () => {
        const adapter = new OpenAIProviderAdapter({
            apiEndpoint: 'https://api.openai.com/v1',
            config: { reasoning: { protocol: 'openai-chat' } },
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
        ['minimal', { reasoningEffort: 'low', thinking: { type: 'enabled' } }],
        ['low', { reasoningEffort: 'low', thinking: { type: 'enabled' } }],
        ['medium', { reasoningEffort: 'high', thinking: { type: 'enabled' } }],
        ['high', { reasoningEffort: 'high', thinking: { type: 'enabled' } }],
        ['xhigh', { reasoningEffort: 'max', thinking: { type: 'enabled' } }],
        ['max', { reasoningEffort: 'max', thinking: { type: 'enabled' } }],
    ] as const)('maps %s to the DeepSeek provider option', (level, expected) => {
        expect(translateDeepSeekReasoningOptions(level)).toEqual(expected);
    });

    it('defaults to max', () => {
        expect(translateDeepSeekReasoningOptions(undefined)).toEqual({
            reasoningEffort: 'max',
            thinking: { type: 'enabled' },
        });
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

describe('reasoning capability normalization', () => {
    it('accepts both object and array upstream shapes', () => {
        expect(normalizeReasoningOptions({ type: 'toggle' })).toEqual([{ type: 'toggle' }]);
        expect(
            normalizeReasoningOptions([
                { type: 'effort', values: ['low', 'high', 'max'] },
                { type: 'budget_tokens', min: 1024 },
            ])
        ).toEqual([
            { type: 'effort', values: ['low', 'high', 'max'] },
            { type: 'budget_tokens', min: 1024 },
        ]);
    });

    it('drops malformed entries and empty effort lists', () => {
        expect(normalizeReasoningOptions(null)).toEqual([]);
        expect(normalizeReasoningOptions({ type: 'effort', values: [] })).toEqual([]);
        expect(normalizeReasoningOptions([null, 'x', { type: 'unknown' }])).toEqual([]);
    });
});

describe('reasoning resolver', () => {
    const effortCapability: ReasoningOption[] = [
        { type: 'effort', values: ['none', 'low', 'medium', 'high'] },
    ];

    it('snaps to the nearest supported level and prefers the higher level on ties', () => {
        const plan = resolveReasoning({
            level: 'xhigh',
            capability: effortCapability,
            protocol: 'openai-chat',
            mode: 'auto',
            modelId: 'test',
            hasTools: false,
        });
        expect(plan.native).toEqual({ kind: 'effort', effort: 'high' });
        expect(plan.source).toBe('capability');
    });

    it('uses max by default and maps it onto the closest native level', () => {
        const plan = resolveReasoning({
            level: undefined,
            capability: effortCapability,
            protocol: 'openai-chat',
            mode: 'auto',
            modelId: 'test',
            hasTools: false,
        });
        expect(plan.requested).toBe('max');
        expect(plan.native).toEqual({ kind: 'effort', effort: 'high' });
    });

    it('sends nothing when metadata is missing and mode is auto', () => {
        const plan = resolveReasoning({
            level: 'max',
            capability: [],
            protocol: 'openai-chat',
            mode: 'auto',
            modelId: 'test',
            hasTools: false,
        });
        expect(plan.source).toBe('fallback');
        expect(plan.native).toEqual({ kind: 'none' });
    });

    it('passes the canonical level through when mode is passthrough', () => {
        const plan = resolveReasoning({
            level: 'xhigh',
            capability: [],
            protocol: 'openai-compatible',
            mode: 'passthrough',
            modelId: 'test',
            hasTools: false,
        });
        expect(plan.native).toEqual({ kind: 'effort', effort: 'xhigh' });
    });

    it('disables reasoning entirely when mode is off', () => {
        const plan = resolveReasoning({
            level: 'max',
            capability: effortCapability,
            protocol: 'openai-chat',
            mode: 'off',
            modelId: 'test',
            hasTools: false,
        });
        expect(plan.source).toBe('off');
        expect(plan.native).toEqual({ kind: 'none' });
    });
});

describe('OpenAI-compatible reasoning translation', () => {
    it('remaps protocol options into the OpenAI-compatible namespace', () => {
        const adapter = new OpenAICompatibleProviderAdapter({
            apiEndpoint: 'https://relay.example.com/v1',
            config: { reasoning: { protocol: 'deepseek-chat', mode: 'passthrough' } },
        });
        const probe = adapter as unknown as {
            getStreamProviderOptions(options: AiRequestOptions): unknown;
        };

        expect(
            probe.getStreamProviderOptions({
                model: 'deepseek-v4.1-flash',
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel: 'max',
            })
        ).toEqual({
            openaiCompatible: {
                reasoningEffort: 'max',
                thinking: { type: 'enabled' },
            },
        });
    });
});
describe('reasoning protocol encoders', () => {
    function planFor(
        protocol: Parameters<typeof encodeReasoning>[0]['protocol'],
        native: Parameters<typeof encodeReasoning>[0]['native']
    ) {
        return {
            protocol,
            mode: 'auto' as const,
            requested: 'max' as const,
            native,
            source: 'capability' as const,
            hasTools: false,
            modelId: 'test',
        };
    }

    it('encodes openai-chat as reasoningEffort only', () => {
        expect(encodeReasoning(planFor('openai-chat', { kind: 'effort', effort: 'high' }))).toEqual(
            { providerOptions: { openai: { reasoningEffort: 'high' } } }
        );
    });

    it('encodes openai-responses with stateless replay options', () => {
        expect(
            encodeReasoning(planFor('openai-responses', { kind: 'effort', effort: 'max' }))
        ).toEqual({
            providerOptions: {
                openai: {
                    store: false,
                    reasoningSummary: 'auto',
                    include: ['reasoning.encrypted_content'],
                    reasoningEffort: 'max',
                },
            },
        });
    });

    it('encodes deepseek-chat toggle and effort', () => {
        expect(
            encodeReasoning(planFor('deepseek-chat', { kind: 'toggle', enabled: false }))
        ).toEqual({ providerOptions: { deepseek: { thinking: { type: 'disabled' } } } });
        expect(
            encodeReasoning(planFor('deepseek-chat', { kind: 'effort', effort: 'max' }))
        ).toEqual({
            providerOptions: {
                deepseek: { reasoningEffort: 'max', thinking: { type: 'enabled' } },
            },
        });
    });

    it('encodes anthropic-messages toggle as adaptive / disabled thinking', () => {
        expect(
            encodeReasoning(planFor('anthropic-messages', { kind: 'toggle', enabled: true }))
        ).toEqual({
            providerOptions: {
                anthropic: { thinking: { type: 'adaptive', display: 'summarized' } },
            },
        });
        expect(
            encodeReasoning(planFor('anthropic-messages', { kind: 'toggle', enabled: false }))
        ).toEqual({ providerOptions: { anthropic: { thinking: { type: 'disabled' } } } });
    });

    it('emits nothing when there is no reasoning signal (auto + missing metadata)', () => {
        const base = {
            ...planFor('openai-chat', { kind: 'none' as const }),
            source: 'fallback' as const,
        };
        expect(encodeReasoning(base)).toEqual({});
        expect(encodeReasoning({ ...base, protocol: 'openai-compatible' })).toEqual({});
        expect(encodeReasoning({ ...base, protocol: 'deepseek-chat' })).toEqual({});
        expect(encodeReasoning({ ...base, protocol: 'anthropic-messages' })).toEqual({});
        expect(encodeReasoning({ ...base, protocol: 'google-generative' })).toEqual({});
    });

    it('keeps only stateless defaults for openai-responses without a reasoning signal', () => {
        expect(
            encodeReasoning({
                ...planFor('openai-responses', { kind: 'none' }),
                source: 'fallback',
            })
        ).toEqual({ providerOptions: { openai: { store: false } } });
    });

    it('encodes anthropic-messages budget as thinking budgetTokens', () => {
        expect(
            encodeReasoning(planFor('anthropic-messages', { kind: 'budget', tokens: 4096 }))
        ).toEqual({
            providerOptions: {
                anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } },
            },
        });
    });

    it('encodes google-generative budget as thinkingConfig', () => {
        expect(
            encodeReasoning(planFor('google-generative', { kind: 'budget', tokens: 2048 }))
        ).toEqual({
            providerOptions: {
                google: { thinkingConfig: { thinkingBudget: 2048, includeThoughts: true } },
            },
        });
    });

    it('encodes openai-compatible as a passthrough effort', () => {
        expect(
            encodeReasoning(planFor('openai-compatible', { kind: 'effort', effort: 'xhigh' }))
        ).toEqual({ providerOptions: { openaiCompatible: { reasoningEffort: 'xhigh' } } });
    });

    it('emits nothing when the plan source is off', () => {
        expect(
            encodeReasoning({
                ...planFor('openai-responses', { kind: 'none' }),
                source: 'off',
            })
        ).toEqual({});
    });
});
