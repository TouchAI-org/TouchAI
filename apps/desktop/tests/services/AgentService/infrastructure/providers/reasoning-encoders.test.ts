// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { describe, expect, it } from 'vitest';

import type { ReasoningProtocol } from '@/services/AgentService/contracts/reasoning';
import { encodeReasoning } from '@/services/AgentService/infrastructure/providers/reasoning/formats';
import type {
    ReasoningEncodingHints,
    ReasoningResolution,
} from '@/services/AgentService/infrastructure/providers/reasoning/types';

/**
 * The encoder is the last step between a user's reasoning level and the provider request. If it
 * drops the parameter the model silently does not think; if it sends it under the wrong key the
 * provider rejects the call; if it sends "off" to a model that cannot be turned off the user pays
 * for thinking they did not ask for.
 */
function resolution(overrides: Partial<ReasoningResolution> = {}): ReasoningResolution {
    return {
        format: 'openai',
        mode: 'auto',
        requested: 'high',
        level: 'high',
        mapped: undefined,
        map: {},
        budgetTokens: undefined,
        source: 'capability',
        hasTools: false,
        modelId: 'gpt-4o',
        ...overrides,
    };
}

/** The provider options a protocol actually sends, or an empty object. */
function optionsFor(
    res: ReasoningResolution,
    compat?: ReasoningEncodingHints
): Record<string, unknown> {
    return encodeReasoning(res, compat).providerOptions ?? {};
}

describe('user turns reasoning off', () => {
    it('user gets no reasoning parameter sent at all when reasoning is disabled', () => {
        // Every protocol has to honour the explicit off, so the check is exhaustive.
        const protocols: ReasoningProtocol[] = [
            'openai',
            'openai-responses',
            'openrouter',
            'deepseek',
            'together',
            'zai',
            'qwen',
            'qwen-chat-template',
            'chat-template',
            'baseten',
            'string-thinking',
            'ant-ling',
            'anthropic-messages',
            'google-generative',
        ];

        for (const format of protocols) {
            const encoded = encodeReasoning(
                resolution({ format, level: 'off', source: 'off', map: { off: 'none' } }),
                { chatTemplateKwargs: { thinking: { $var: 'thinking.enabled' } } }
            );
            expect(encoded, format).toEqual({});
        }
    });
});

describe('user picks a reasoning level for an OpenAI model', () => {
    it('user gets the level sent as reasoning effort', () => {
        const options = optionsFor(resolution({ format: 'openai', level: 'high' }));

        expect(options.openai).toEqual({ reasoningEffort: 'high' });
    });

    it('user gets the model native value sent when the model declares one', () => {
        const options = optionsFor(resolution({ format: 'openai', level: 'high', mapped: 'high' }));

        // A model that names its own level must receive that name, not the canonical one.
        expect(options.openai).toEqual({ reasoningEffort: 'high' });
    });

    it('user gets no effort sent when the model cannot take one', () => {
        const options = optionsFor(resolution({ format: 'openai', level: 'high' }), {
            supportsReasoningEffort: false,
        });

        expect(options).toEqual({});
    });

    it('user gets the off value sent when the model declares how to disable reasoning', () => {
        const options = optionsFor(
            resolution({
                format: 'openai',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            })
        );

        expect(options.openai).toEqual({ reasoningEffort: 'none' });
    });

    it('user gets no off sent when the model declares no way to disable reasoning', () => {
        const options = optionsFor(
            resolution({
                format: 'openai',
                level: 'off',
                source: 'capability',
                map: { off: null },
            })
        );

        expect(options).toEqual({});
    });

    it('user gets a token budget attached under the declared field', () => {
        const options = optionsFor(resolution({ format: 'openai', level: 'high' }), {
            tokenBudgetField: 'thinking_budget',
        });

        expect(options.openai).toMatchObject({ thinking_budget: expect.any(Number) });
    });

    it('user gets the vLLM budget field used when the model only declares support', () => {
        const options = optionsFor(resolution({ format: 'openai', level: 'high' }), {
            supportsTokenBudget: true,
        });

        // vLLM reads thinking_token_budget; the other field names are ignored by it.
        expect(options.openai).toMatchObject({ thinking_token_budget: expect.any(Number) });
    });
});

describe('user picks a reasoning level for a stateless Responses model', () => {
    it('user gets the request marked stateless with the effort and summary requested', () => {
        const options = optionsFor(resolution({ format: 'openai-responses', level: 'medium' }));

        // A stored response would bill the account and leak the conversation across turns.
        expect(options.openai).toMatchObject({
            store: false,
            reasoningEffort: 'medium',
            reasoningSummary: 'auto',
            forceReasoning: true,
            include: ['reasoning.encrypted_content'],
        });
    });

    it('user gets no reasoning forced when reasoning is off', () => {
        const options = optionsFor(
            resolution({
                format: 'openai-responses',
                level: 'off',
                source: 'fallback',
            })
        );

        // Fallback means the model was never known to support reasoning, so nothing is sent.
        expect(options.openai).toEqual({ store: false });
    });

    it('user gets an explicit none sent when the model declares off support', () => {
        const options = optionsFor(
            resolution({
                format: 'openai-responses',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            })
        );

        expect(options.openai).toMatchObject({ store: false, reasoningEffort: 'none' });
    });
});

describe('user picks a reasoning level for a gateway model', () => {
    it('user gets openrouter its nested reasoning effort', () => {
        const options = optionsFor(resolution({ format: 'openrouter', level: 'low' }));

        expect(options.openaiCompatible).toEqual({ reasoning: { effort: 'low' } });
    });

    it('user gets deepseek a thinking type alongside its effort', () => {
        const options = optionsFor(resolution({ format: 'deepseek', level: 'high' }));

        expect(options.deepseek).toEqual({
            thinking: { type: 'enabled' },
            reasoningEffort: 'high',
        });
    });

    it('user gets deepseek thinking disabled when it is turned off', () => {
        const options = optionsFor(
            resolution({
                format: 'deepseek',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            })
        );

        expect(options.deepseek).toEqual({ thinking: { type: 'disabled' } });
    });

    it('user gets nothing sent when a gateway model has no reasoning metadata', () => {
        // These four all treat an unknown model as "do not send anything".
        for (const format of ['together', 'zai', 'qwen', 'qwen-chat-template'] as const) {
            const options = optionsFor(resolution({ format, level: 'off', source: 'fallback' }));
            expect(options, format).toEqual({});
        }
    });

    it('user gets together its own reasoning flag', () => {
        const options = optionsFor(resolution({ format: 'together', level: 'high' }));

        expect(options.openaiCompatible).toEqual({
            reasoning: { enabled: true },
            reasoningEffort: 'high',
        });
    });

    it('user gets zai a thinking type that keeps earlier reasoning', () => {
        const options = optionsFor(resolution({ format: 'zai', level: 'high' }));

        // clear_thinking: false keeps the earlier turn's reasoning, which zai bills for.
        expect(options.openaiCompatible).toEqual({
            thinking: { type: 'enabled', clear_thinking: false },
            reasoningEffort: 'high',
        });
    });

    it('user gets qwen its enable flag', () => {
        const options = optionsFor(resolution({ format: 'qwen', level: 'high' }));

        expect(options.openaiCompatible).toEqual({
            enable_thinking: true,
            reasoningEffort: 'high',
        });
    });

    it('user gets qwen off as a disabled flag rather than nothing', () => {
        const options = optionsFor(
            resolution({
                format: 'qwen',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            })
        );

        expect(options.openaiCompatible).toEqual({ enable_thinking: false });
    });

    it('user gets qwen chat template its kwargs with thinking preserved', () => {
        const options = optionsFor(resolution({ format: 'qwen-chat-template', level: 'high' }));

        expect(options.openaiCompatible).toEqual({
            chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
        });
    });

    it('user gets a string-thinking model its effort as a plain string', () => {
        const options = optionsFor(resolution({ format: 'string-thinking', level: 'medium' }));

        expect(options.openaiCompatible).toEqual({ thinking: 'medium' });
    });

    it('user gets ant-ling an effort only when the model declares one', () => {
        const declared = optionsFor(
            resolution({ format: 'ant-ling', level: 'high', mapped: 'high' })
        );
        const undeclared = optionsFor(
            resolution({ format: 'ant-ling', level: 'high', mapped: undefined })
        );

        // This protocol only forwards a declared native value; a canonical level is not one.
        expect(declared.openaiCompatible).toEqual({ reasoning: { effort: 'high' } });
        expect(undeclared).toEqual({});
    });

    it('user gets ant-ling its own declared value, not the canonical level', () => {
        const options = optionsFor(
            resolution({ format: 'ant-ling', level: 'medium', mapped: 'vendor-specific' })
        );

        expect(options.openaiCompatible).toEqual({ reasoning: { effort: 'vendor-specific' } });
    });
});

describe('user picks a reasoning level for a chat-template model', () => {
    it('user gets each template placeholder resolved', () => {
        const options = optionsFor(resolution({ format: 'chat-template', level: 'high' }), {
            chatTemplateKwargs: {
                thinking: { $var: 'thinking.enabled' },
                budget: { $var: 'thinking.budget' },
                level: 'literal-value',
            },
        });

        expect(options.openaiCompatible).toEqual({
            chat_template_kwargs: {
                thinking: true,
                budget: expect.any(Number),
                level: 'literal-value',
            },
        });
    });

    it('user gets a placeholder omitted when reasoning is off and the template says so', () => {
        const options = optionsFor(
            resolution({
                format: 'chat-template',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            }),
            {
                chatTemplateKwargs: {
                    thinking: { $var: 'thinking.enabled', omitWhenOff: true },
                },
            }
        );

        // A template that omits the key on off must not receive it as false.
        expect(options.openaiCompatible).toBeUndefined();
    });

    it('user gets the off value used for a placeholder that is not omitted', () => {
        const options = optionsFor(
            resolution({
                format: 'chat-template',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            }),
            { chatTemplateKwargs: { effort: 'fallback-literal' } }
        );

        // A literal template value is passed through untouched, even when reasoning is off.
        expect(options.openaiCompatible).toEqual({
            chat_template_kwargs: { effort: 'fallback-literal' },
        });
    });

    it('user gets nothing when the model declares no template at all', () => {
        const options = optionsFor(resolution({ format: 'chat-template', level: 'high' }));

        expect(options).toEqual({});
    });

    it('user gets baseten its chat template args and effort together', () => {
        const options = optionsFor(resolution({ format: 'baseten', level: 'medium' }), {
            chatTemplateArgs: { thinking: { $var: 'thinking.enabled' } },
        });

        expect(options.openaiCompatible).toEqual({
            chat_template_args: { thinking: true },
            reasoningEffort: 'medium',
        });
    });
});

describe('user picks a reasoning level for an Anthropic model', () => {
    it('user gets a thinking budget for a model that bills by budget', () => {
        const options = optionsFor(resolution({ format: 'anthropic-messages', level: 'high' }));

        expect(options.anthropic).toMatchObject({
            thinking: { type: 'enabled', budgetTokens: expect.any(Number) },
        });
    });

    it('user gets the computed budget sent as the thinking budget', () => {
        const options = optionsFor(
            resolution({
                format: 'anthropic-messages',
                level: 'high',
                budgetTokens: 8192,
            })
        );

        expect(options.anthropic).toEqual({
            thinking: { type: 'enabled', budgetTokens: 8192 },
        });
    });

    it('user gets adaptive thinking with a mapped effort on a newer model', () => {
        const options = optionsFor(resolution({ format: 'anthropic-messages', level: 'high' }), {
            forceAdaptiveThinking: true,
        });

        expect(options.anthropic).toEqual({
            thinking: { type: 'adaptive', display: 'summarized' },
            effort: 'high',
        });
    });

    it('user gets each level mapped to the nearest adaptive effort', () => {
        const effortFor = (level: ReasoningResolution['level']) =>
            (
                optionsFor(resolution({ format: 'anthropic-messages', level }), {
                    forceAdaptiveThinking: true,
                }).anthropic as Record<string, unknown>
            ).effort;

        // The adaptive API has three steps, so the seven levels have to collapse into them.
        expect(effortFor('minimal')).toBe('low');
        expect(effortFor('low')).toBe('low');
        expect(effortFor('medium')).toBe('medium');
        expect(effortFor('high')).toBe('high');
        expect(effortFor('max')).toBe('high');
    });

    it('user gets a declared native effort preferred over the collapse', () => {
        const options = optionsFor(
            resolution({ format: 'anthropic-messages', level: 'high', mapped: 'custom' }),
            { forceAdaptiveThinking: true }
        );

        expect(options.anthropic).toMatchObject({ effort: 'custom' });
    });

    it('user gets thinking disabled when it is turned off', () => {
        const options = optionsFor(
            resolution({
                format: 'anthropic-messages',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            })
        );

        expect(options.anthropic).toEqual({ thinking: { type: 'disabled' } });
    });
});

describe('user picks a reasoning level for a Google model', () => {
    it('user gets a thinking budget for a model that bills by budget', () => {
        const options = optionsFor(
            resolution({ format: 'google-generative', level: 'high', modelId: 'gemini-2.5-pro' })
        );

        expect(options.google).toEqual({
            thinkingConfig: { thinkingBudget: expect.any(Number), includeThoughts: true },
        });
    });

    it('user gets a thinking level for a model that takes discrete levels', () => {
        const options = optionsFor(
            resolution({ format: 'google-generative', level: 'high', modelId: 'gemini-3-pro' })
        );

        expect(options.google).toEqual({
            thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true },
        });
    });

    it('user gets each level sent as the matching Google level', () => {
        const levelFor = (level: ReasoningResolution['level']) =>
            (
                optionsFor(
                    resolution({
                        format: 'google-generative',
                        level,
                        modelId: 'gemini-3-flash',
                    })
                ).google as { thinkingConfig: Record<string, unknown> }
            ).thinkingConfig.thinkingLevel;

        expect(levelFor('minimal')).toBe('MINIMAL');
        expect(levelFor('low')).toBe('LOW');
        expect(levelFor('medium')).toBe('MEDIUM');
        expect(levelFor('high')).toBe('HIGH');
        expect(levelFor('max')).toBe('HIGH');
    });

    it('user gets thinking switched off with a zero budget', () => {
        const options = optionsFor(
            resolution({
                format: 'google-generative',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
                modelId: 'gemini-2.5-pro',
            })
        );

        expect(options.google).toEqual({
            thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
        });
    });
});
