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

describe('user picks how hard the model should think', () => {
    it('user sees only canonical reasoning levels accepted', () => {
        expect(isSelectableReasoningLevel('off')).toBe(true);
        expect(isSelectableReasoningLevel('high')).toBe(true);
        expect(isSelectableReasoningLevel('max')).toBe(true);
        expect(isSelectableReasoningLevel('ultra')).toBe(true);
        expect(isSelectableReasoningLevel('none')).toBe(false);
        expect(isSelectableReasoningLevel('bogus')).toBe(false);
        expect(isSelectableReasoningLevel(undefined)).toBe(false);
    });

    it('user sees the strongest level used until the model is known', () => {
        expect(DEFAULT_REASONING_LEVEL).toBe('max');
    });
});

describe('user sees whether a model can turn reasoning off', () => {
    it('user sees an effort list without off reported as unable to disable reasoning', () => {
        const map = deriveReasoningLevelMap([
            { type: 'effort', values: ['minimal', 'low', 'medium', 'high'] },
        ]);
        expect(map.off).toBeNull();
        expect(map.high).toBe('high');
        expect(map.max).toBeNull();
        expect(clampReasoningLevel(map, 'max')).toBe('high');
    });

    it('user sees none mapped to off and higher levels kept only when declared', () => {
        const map = deriveReasoningLevelMap([
            { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] },
        ]);
        expect(map.off).toBe('none');
        expect(map.xhigh).toBe('xhigh');
        expect(map.max).toBeNull();
        expect(map.ultra).toBeNull();
        expect(clampReasoningLevel(map, 'max')).toBe('xhigh');
    });

    it('user sees a gateway-only level passed through when the model declares it', () => {
        const map = deriveReasoningLevelMap([
            { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        ]);
        expect(map.ultra).toBe('ultra');
        expect(clampReasoningLevel(map, 'ultra')).toBe('ultra');

        const withoutUltra = deriveReasoningLevelMap([
            { type: 'effort', values: ['low', 'medium', 'high'] },
        ]);
        expect(withoutUltra.ultra).toBeNull();
        expect(clampReasoningLevel(withoutUltra, 'ultra')).toBe('high');
    });
});

describe('user sees the requested reasoning level clamped to what the model supports', () => {
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
    ] as const)('user sees the strongest level clamped for %s to %s', (modelId, expected) => {
        expect(resolveLevel(modelId)).toBe(expected);
    });

    it('user sees an explicitly requested level mapped to the nearest supported one', () => {
        expect(resolveLevel('gpt-5.1', 'xhigh')).toBe('high');
        expect(resolveLevel('gpt-5', 'off')).toBe('minimal');
        expect(resolveLevel('gpt-5.1', 'minimal')).toBe('low');
        expect(resolveLevel('gpt-5.4-pro', 'off')).toBe('medium');
        expect(resolveLevel('gpt-5.2', 'medium')).toBe('medium');
    });

    it('user sees no reasoning levels for unknown or non-reasoning models', () => {
        expect(getOpenAiReasoningLevelMap('gpt-4o')).toEqual({});
        expect(getOpenAiReasoningLevelMap('gpt-5-chat-latest')).toEqual({});
        expect(getOpenAiReasoningLevelMap('unknown-model')).toEqual({});
    });

    it('user sees the official driver default to stateless Responses', () => {
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
                forceReasoning: true,
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
                forceReasoning: true,
                reasoningEffort: 'max',
                reasoningSummary: 'auto',
                include: ['reasoning.encrypted_content'],
            },
        });
    });

    it('user sees Chat Completions used when the transport is overridden', () => {
        const adapter = new OpenAIProviderAdapter({
            apiEndpoint: 'https://api.openai.com/v1',
            config: { reasoning: { format: 'deepseek' } },
        });

        expect(adapter.getApiTargets().generationTarget).toBe(
            'https://api.openai.com/v1/chat/completions'
        );
    });

    it('user keeps the Chat Completions constraint when the transport is overridden', () => {
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

    it('user sees no reasoning sent when metadata declares it unsupported', () => {
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

        // 未声明能力时保留硬编码兜底表。
        expect(probe.getStreamProviderOptions(baseOptions)).toEqual({
            openai: { reasoningEffort: 'max' },
        });
        // 显式 false 优先于兜底表和残留档位。
        expect(
            probe.getStreamProviderOptions({ ...baseOptions, supportsReasoning: false })
        ).toBeUndefined();
        expect(
            probe.getStreamProviderOptions({
                ...baseOptions,
                supportsReasoning: false,
                reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
            })
        ).toBeUndefined();
    });

    it('user sees an explicit passthrough override an unsupported declaration', () => {
        const adapter = new OpenAIProviderAdapter({
            apiEndpoint: 'https://api.openai.com/v1',
            config: { reasoning: { format: 'openai', mode: 'passthrough' } },
        });
        const probe = adapter as unknown as {
            getStreamProviderOptions(options: AiRequestOptions): unknown;
        };

        expect(
            probe.getStreamProviderOptions({
                model: 'gpt-6-sol',
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel: 'max',
                supportsReasoning: false,
            })
        ).toEqual({ openai: { reasoningEffort: 'max' } });
    });
});

describe('user sees reasoning capabilities read from upstream', () => {
    it('user sees both object and array upstream shapes accepted', () => {
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

    it('user sees malformed entries and empty effort lists dropped', () => {
        expect(normalizeReasoningOptions(null)).toEqual([]);
        expect(normalizeReasoningOptions({ type: 'effort', values: [] })).toEqual([]);
        expect(normalizeReasoningOptions([null, 'x', { type: 'unknown' }])).toEqual([]);
    });
});

describe('user sees the requested level resolved against the model', () => {
    const options: ReasoningOption[] = [
        { type: 'effort', values: ['none', 'low', 'medium', 'high'] },
    ];
    const effortMap = deriveReasoningLevelMap(options);

    it('user sees the nearest supported level chosen with the higher one on ties', () => {
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

    it('user sees the strongest level by default mapped onto the closest native one', () => {
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

    it('user sees nothing sent when metadata is missing and the mode is auto', () => {
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

    it('user sees the canonical level passed through in passthrough mode', () => {
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

    it('user sees reasoning disabled entirely when the mode is off', () => {
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

describe('user sees reasoning options remapped for an OpenAI-compatible relay', () => {
    it('user sees encoded options land in the OpenAI-compatible namespace', () => {
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

describe('user sees each provider get its own reasoning wire format', () => {
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

    it('user sees reasoning encoded as reasoningEffort for OpenAI', () => {
        expect(encodeReasoning(plan('openai', 'high', 'high'))).toEqual({
            providerOptions: { openai: { reasoningEffort: 'high' } },
        });
    });

    it('user sees stateless replay options encoded for OpenAI Responses', () => {
        expect(encodeReasoning(plan('openai-responses', 'max', 'max'))).toEqual({
            providerOptions: {
                openai: {
                    store: false,
                    forceReasoning: true,
                    reasoningEffort: 'max',
                    reasoningSummary: 'auto',
                    include: ['reasoning.encrypted_content'],
                },
            },
        });
    });

    it('user sees reasoning encoded as reasoning.effort for OpenRouter', () => {
        expect(encodeReasoning(plan('openrouter', 'high', 'high'))).toEqual({
            providerOptions: { openaiCompatible: { reasoning: { effort: 'high' } } },
        });
    });

    it('user sees the DeepSeek thinking toggle and effort encoded', () => {
        expect(encodeReasoning(plan('deepseek', 'off', undefined))).toEqual({
            providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
        });
        expect(encodeReasoning(plan('deepseek', 'max', 'max'))).toEqual({
            providerOptions: {
                deepseek: { reasoningEffort: 'max', thinking: { type: 'enabled' } },
            },
        });
    });

    it('user sees Anthropic adaptive thinking encoded with an effort', () => {
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

    it('user sees an Anthropic thinking budget encoded as budgetTokens', () => {
        expect(
            encodeReasoning(plan('anthropic-messages', 'medium', undefined, { budgetTokens: 4096 }))
        ).toEqual({
            providerOptions: {
                anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } },
            },
        });
    });

    it('user sees a Google thinking budget encoded as thinkingConfig', () => {
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

    it('user sees nothing encoded when there is no reasoning signal', () => {
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

    it('user keeps only the stateless default for OpenAI Responses without a reasoning signal', () => {
        expect(
            encodeReasoning(plan('openai-responses', 'off', undefined, { source: 'fallback' }))
        ).toEqual({ providerOptions: { openai: { store: false } } });
    });

    it('user sees nothing encoded when reasoning is off', () => {
        expect(
            encodeReasoning(plan('openai-responses', 'off', undefined, { source: 'off' }))
        ).toEqual({});
    });
});
