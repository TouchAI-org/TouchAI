import { describe, expect, it } from 'vitest';

import type { AiRequestOptions } from '@/services/AgentService/contracts/protocol';
import {
    clampReasoningLevel,
    DEFAULT_REASONING_LEVEL,
    deriveReasoningLevelMap,
    isSelectableReasoningLevel,
    normalizeReasoningOptions,
    type ReasoningOption,
    type SelectableReasoningLevel,
} from '@/services/AgentService/contracts/reasoning';
import { OpenAIProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/openai';
import { OpenAICompatibleProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/openai-compatible';
import {
    encodeReasoning,
    getOpenAiReasoningLevelMap,
    type ReasoningResolution,
    resolveReasoning,
} from '@/services/AgentService/infrastructure/providers/reasoning';

describe('reasoning level contract', () => {
    it('accepts only TouchAI canonical reasoning levels', () => {
        expect(isSelectableReasoningLevel('off')).toBe(true);
        expect(isSelectableReasoningLevel('high')).toBe(true);
        expect(isSelectableReasoningLevel('max')).toBe(true);
        expect(isSelectableReasoningLevel('none')).toBe(false);
        expect(isSelectableReasoningLevel('bogus')).toBe(false);
        expect(isSelectableReasoningLevel(undefined)).toBe(false);
    });

    it('uses max as the temporary default', () => {
        expect(DEFAULT_REASONING_LEVEL).toBe('max');
    });
});

describe('reasoning level map', () => {
    it('treats an effort enum without none/off as unable to disable reasoning', () => {
        const map = deriveReasoningLevelMap([
            { type: 'effort', values: ['minimal', 'low', 'medium', 'high'] },
        ]);
        expect(map.off).toBeNull();
        expect(map.high).toBe('high');
        expect(map.max).toBeNull();
        expect(clampReasoningLevel(map, 'max')).toBe('high');
    });

    it('maps none onto the off level and keeps xhigh/max only when declared', () => {
        const map = deriveReasoningLevelMap([
            { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] },
        ]);
        expect(map.off).toBe('none');
        expect(map.xhigh).toBe('xhigh');
        expect(map.max).toBeNull();
        expect(clampReasoningLevel(map, 'max')).toBe('xhigh');
    });
});

describe('OpenAI reasoning level map', () => {
    function resolveLevel(
        modelId: string,
        level: SelectableReasoningLevel = DEFAULT_REASONING_LEVEL
    ) {
        return resolveReasoning({
            level,
            map: getOpenAiReasoningLevelMap(modelId),
            format: 'openai-responses',
            mode: 'auto',
            modelId,
            hasTools: false,
        }).level;
    }

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
        expect(resolveLevel(modelId)).toBe(expected);
    });

    it('maps an explicitly requested level to the nearest supported model level', () => {
        expect(resolveLevel('gpt-5.1', 'xhigh')).toBe('high');
        expect(resolveLevel('gpt-5', 'off')).toBe('minimal');
        expect(resolveLevel('gpt-5.1', 'minimal')).toBe('low');
        expect(resolveLevel('gpt-5.4-pro', 'off')).toBe('medium');
        expect(resolveLevel('gpt-5.2', 'medium')).toBe('medium');
    });

    it('returns an empty map for unknown or non-reasoning OpenAI models', () => {
        expect(getOpenAiReasoningLevelMap('gpt-4o')).toEqual({});
        expect(getOpenAiReasoningLevelMap('gpt-5-chat-latest')).toEqual({});
        expect(getOpenAiReasoningLevelMap('unknown-model')).toEqual({});
    });

    it('defaults the official driver to the stateless Responses format', () => {
        const adapter = new OpenAIProviderAdapter({ apiEndpoint: 'https://api.openai.com/v1' });
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
                reasoningEffort: 'max',
                reasoningSummary: 'auto',
                include: ['reasoning.encrypted_content'],
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
                reasoningEffort: 'max',
                reasoningSummary: 'auto',
                include: ['reasoning.encrypted_content'],
            },
        });
    });

    it('uses Chat Completions transport for non-Responses format overrides', () => {
        const adapter = new OpenAIProviderAdapter({
            apiEndpoint: 'https://api.openai.com/v1',
            config: { reasoning: { format: 'deepseek' } },
        });

        expect(adapter.getApiTargets().generationTarget).toBe(
            'https://api.openai.com/v1/chat/completions'
        );
    });

    it('keeps the Chat Completions constraint when the format is overridden', () => {
        const adapter = new OpenAIProviderAdapter({
            apiEndpoint: 'https://api.openai.com/v1',
            config: { reasoning: { format: 'openai' } },
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
    const options: ReasoningOption[] = [
        { type: 'effort', values: ['none', 'low', 'medium', 'high'] },
    ];
    const effortMap = deriveReasoningLevelMap(options);

    it('snaps to the nearest supported level and prefers the higher level on ties', () => {
        const plan = resolveReasoning({
            level: 'xhigh',
            map: effortMap,
            format: 'openai',
            mode: 'auto',
            modelId: 'test',
            hasTools: false,
        });
        expect(plan.level).toBe('high');
        expect(plan.mapped).toBe('high');
        expect(plan.source).toBe('capability');
    });

    it('uses max by default and maps it onto the closest native level', () => {
        const plan = resolveReasoning({
            level: undefined,
            map: effortMap,
            format: 'openai',
            mode: 'auto',
            modelId: 'test',
            hasTools: false,
        });
        expect(plan.requested).toBe('max');
        expect(plan.level).toBe('high');
        expect(plan.mapped).toBe('high');
    });

    it('sends nothing when metadata is missing and mode is auto', () => {
        const plan = resolveReasoning({
            level: 'max',
            map: {},
            format: 'openai',
            mode: 'auto',
            modelId: 'test',
            hasTools: false,
        });
        expect(plan.source).toBe('fallback');
        expect(plan.level).toBe('off');
    });

    it('passes the canonical level through when mode is passthrough', () => {
        const plan = resolveReasoning({
            level: 'xhigh',
            map: {},
            format: 'openai',
            mode: 'passthrough',
            modelId: 'test',
            hasTools: false,
        });
        expect(plan.level).toBe('xhigh');
        expect(plan.mapped).toBe('xhigh');
        expect(plan.source).toBe('fallback');
    });

    it('disables reasoning entirely when mode is off', () => {
        const plan = resolveReasoning({
            level: 'max',
            map: effortMap,
            format: 'openai',
            mode: 'off',
            modelId: 'test',
            hasTools: false,
        });
        expect(plan.source).toBe('off');
        expect(plan.level).toBe('off');
    });
});

describe('OpenAI-compatible relay', () => {
    it('remaps encoded options into the OpenAI-compatible namespace', () => {
        const adapter = new OpenAICompatibleProviderAdapter({
            apiEndpoint: 'https://relay.example.com/v1',
            config: { reasoning: { format: 'deepseek', mode: 'passthrough' } },
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

describe('reasoning format encoders', () => {
    function plan(
        format: ReasoningResolution['format'],
        level: SelectableReasoningLevel,
        mapped: string | undefined,
        extra: Partial<ReasoningResolution> = {}
    ): ReasoningResolution {
        return {
            format,
            mode: 'auto',
            requested: 'max',
            level,
            mapped,
            map: {},
            budgetTokens: undefined,
            source: 'capability',
            hasTools: false,
            modelId: 'test',
            ...extra,
        };
    }

    it('encodes openai as reasoningEffort only', () => {
        expect(encodeReasoning(plan('openai', 'high', 'high'))).toEqual({
            providerOptions: { openai: { reasoningEffort: 'high' } },
        });
    });

    it('encodes openai-responses with stateless replay options', () => {
        expect(encodeReasoning(plan('openai-responses', 'max', 'max'))).toEqual({
            providerOptions: {
                openai: {
                    store: false,
                    reasoningEffort: 'max',
                    reasoningSummary: 'auto',
                    include: ['reasoning.encrypted_content'],
                },
            },
        });
    });

    it('encodes openrouter as reasoning.effort', () => {
        expect(encodeReasoning(plan('openrouter', 'high', 'high'))).toEqual({
            providerOptions: { openaiCompatible: { reasoning: { effort: 'high' } } },
        });
    });

    it('encodes deepseek thinking toggle and effort', () => {
        expect(encodeReasoning(plan('deepseek', 'off', undefined))).toEqual({
            providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
        });
        expect(encodeReasoning(plan('deepseek', 'max', 'max'))).toEqual({
            providerOptions: {
                deepseek: { reasoningEffort: 'max', thinking: { type: 'enabled' } },
            },
        });
    });

    it('encodes anthropic-messages adaptive thinking with effort', () => {
        expect(
            encodeReasoning(plan('anthropic-messages', 'high', 'high'), {
                forceAdaptiveThinking: true,
            })
        ).toEqual({
            providerOptions: {
                anthropic: {
                    thinking: { type: 'adaptive', display: 'summarized' },
                    effort: 'high',
                },
            },
        });
        expect(encodeReasoning(plan('anthropic-messages', 'off', undefined))).toEqual({
            providerOptions: { anthropic: { thinking: { type: 'disabled' } } },
        });
    });

    it('encodes anthropic-messages budget as thinking budgetTokens', () => {
        expect(
            encodeReasoning(plan('anthropic-messages', 'medium', undefined, { budgetTokens: 4096 }))
        ).toEqual({
            providerOptions: {
                anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } },
            },
        });
    });

    it('encodes google-generative budget as thinkingConfig', () => {
        expect(
            encodeReasoning(
                plan('google-generative', 'low', undefined, {
                    budgetTokens: 2048,
                    modelId: 'gemini-2.5-pro',
                })
            )
        ).toEqual({
            providerOptions: {
                google: { thinkingConfig: { thinkingBudget: 2048, includeThoughts: true } },
            },
        });
    });

    it('emits nothing when there is no reasoning signal (auto + missing metadata)', () => {
        const base = plan('openai', 'off', undefined, { source: 'fallback' });
        expect(encodeReasoning(base)).toEqual({});
        for (const format of [
            'openrouter',
            'deepseek',
            'together',
            'zai',
            'qwen',
            'qwen-chat-template',
            'anthropic-messages',
            'google-generative',
        ] as const) {
            expect(encodeReasoning({ ...base, format })).toEqual({});
        }
    });

    it('keeps only the stateless default for openai-responses without a reasoning signal', () => {
        expect(
            encodeReasoning(plan('openai-responses', 'off', undefined, { source: 'fallback' }))
        ).toEqual({ providerOptions: { openai: { store: false } } });
    });

    it('emits nothing when the resolution source is off', () => {
        expect(
            encodeReasoning(plan('openai-responses', 'off', undefined, { source: 'off' }))
        ).toEqual({});
    });
});
