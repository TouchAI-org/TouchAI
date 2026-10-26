/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { describe, expect, it } from 'vitest';

import { encodeReasoning } from '@/services/AgentService/infrastructure/providers/reasoning/formats';
import type {
    ReasoningEncodingHints,
    ReasoningResolution,
} from '@/services/AgentService/infrastructure/providers/reasoning/types';

/**
 * Complements reasoning-encoders.test.ts with the "turned off" and "model cannot take an
 * effort" arms of each gateway protocol, plus the budget-less paths.
 *
 * Why these matter: sending an off marker to a provider that never declared one makes it
 * reject the request, and omitting the budget when the model has no declared limit makes
 * thinking consume the whole response.
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

function optionsFor(
    res: ReasoningResolution,
    compat?: ReasoningEncodingHints
): Record<string, unknown> {
    return encodeReasoning(res, compat).providerOptions ?? {};
}

describe('user turns reasoning off on a gateway model that can say so', () => {
    it('user gets the declared off value sent for a gateway model', () => {
        const options = optionsFor(
            resolution({
                format: 'openrouter',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            })
        );

        expect(options.openaiCompatible).toEqual({ reasoning: { effort: 'none' } });
    });

    it('user gets none sent when the model declares off support without naming a value', () => {
        const options = optionsFor(
            resolution({
                format: 'openrouter',
                level: 'off',
                source: 'capability',
                // Off is supported but no native spelling was recorded.
                map: {},
            })
        );

        expect(options.openaiCompatible).toEqual({ reasoning: { effort: 'none' } });
    });

    it('user gets none sent for a stateless model that declares off without a spelling', () => {
        const options = optionsFor(
            resolution({
                format: 'openai-responses',
                level: 'off',
                source: 'capability',
                map: {},
            })
        );

        expect(options.openai).toEqual({ store: false, reasoningEffort: 'none' });
    });

    it('user gets deepseek told to disable thinking', () => {
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

    it('user gets zai told to disable thinking', () => {
        const options = optionsFor(
            resolution({
                format: 'zai',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            })
        );

        expect(options.openaiCompatible).toEqual({ thinking: { type: 'disabled' } });
    });

    it('user gets together told to disable reasoning', () => {
        const options = optionsFor(
            resolution({
                format: 'together',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            })
        );

        expect(options.openaiCompatible).toEqual({ reasoning: { enabled: false } });
    });

    it('user gets qwen chat template its thinking flag set to false', () => {
        const options = optionsFor(
            resolution({
                format: 'qwen-chat-template',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            })
        );

        expect(options.openaiCompatible).toEqual({
            chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
        });
    });

    it('user gets a string-thinking model told to stop thinking', () => {
        const options = optionsFor(
            resolution({
                format: 'string-thinking',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            })
        );

        expect(options.openaiCompatible).toEqual({ thinking: 'none' });
    });

    it('user gets none sent for string-thinking when no off spelling was declared', () => {
        const options = optionsFor(
            resolution({
                format: 'string-thinking',
                level: 'off',
                source: 'capability',
                map: {},
            })
        );

        expect(options.openaiCompatible).toEqual({ thinking: 'none' });
    });
});

describe('user turns reasoning off on a model that never declared off support', () => {
    it('user gets nothing sent rather than an off the provider would reject', () => {
        // source=fallback means the model was never known to support reasoning at all.
        for (const format of ['openai', 'openrouter', 'deepseek', 'string-thinking'] as const) {
            const options = optionsFor(resolution({ format, level: 'off', source: 'fallback' }));
            expect(options, format).toEqual({});
        }
    });

    it('user gets no thinking marker for an Anthropic model that never declared one', () => {
        const options = optionsFor(
            resolution({ format: 'anthropic-messages', level: 'off', source: 'fallback' })
        );

        expect(options).toEqual({});
    });

    it('user gets no thinking config for a Google model that never declared one', () => {
        const options = optionsFor(
            resolution({ format: 'google-generative', level: 'off', source: 'fallback' })
        );

        expect(options).toEqual({});
    });

    it('user gets no effort for an [OI] model that cannot take one while off', () => {
        const options = optionsFor(
            resolution({
                format: 'openai',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            }),
            { supportsReasoningEffort: false }
        );

        expect(options).toEqual({});
    });
});

describe('user picks a level on a model that cannot take an effort parameter', () => {
    it('user gets only the thinking flag from deepseek', () => {
        const options = optionsFor(resolution({ format: 'deepseek', level: 'high' }), {
            supportsReasoningEffort: false,
        });

        // The enabled marker still has to be sent; only the effort is unsupported.
        expect(options.deepseek).toEqual({ thinking: { type: 'enabled' } });
    });

    it('user gets only the reasoning flag from together', () => {
        const options = optionsFor(resolution({ format: 'together', level: 'high' }), {
            supportsReasoningEffort: false,
        });

        expect(options.openaiCompatible).toEqual({ reasoning: { enabled: true } });
    });

    it('user gets only the thinking flag from zai', () => {
        const options = optionsFor(resolution({ format: 'zai', level: 'high' }), {
            supportsReasoningEffort: false,
        });

        expect(options.openaiCompatible).toEqual({
            thinking: { type: 'enabled', clear_thinking: false },
        });
    });

    it('user gets only the enable flag from qwen', () => {
        const options = optionsFor(resolution({ format: 'qwen', level: 'high' }), {
            supportsReasoningEffort: false,
        });

        expect(options.openaiCompatible).toEqual({ enable_thinking: true });
    });

    it('user gets baseten its args without an effort', () => {
        const options = optionsFor(resolution({ format: 'baseten', level: 'medium' }), {
            supportsReasoningEffort: false,
            chatTemplateArgs: { thinking: { $var: 'thinking.enabled' } },
        });

        expect(options.openaiCompatible).toEqual({ chat_template_args: { thinking: true } });
    });
});

describe('user picks a level on a model whose budget is not stated', () => {
    it('user gets no budget field for an Anthropic model that declares none', () => {
        // The model overrides the default budget with nothing, so there is no number to send.
        const options = optionsFor(resolution({ format: 'anthropic-messages', level: 'low' }), {
            reasoningTokenBudgets: { low: undefined },
        });

        expect(options.anthropic).toEqual({ thinking: { type: 'enabled' } });
    });

    it('user gets no budget field for a Google model that declares none', () => {
        const options = optionsFor(
            resolution({
                format: 'google-generative',
                level: 'low',
                modelId: 'gemini-2.5-pro',
            }),
            { reasoningTokenBudgets: { low: undefined } }
        );

        expect(options.google).toEqual({
            thinkingConfig: { thinkingBudget: -1, includeThoughts: true },
        });
    });

    it('user gets no top-level budget written for an [OI] model that declares none', () => {
        const options = optionsFor(resolution({ format: 'openai', level: 'low' }), {
            tokenBudgetField: 'thinking_budget',
            reasoningTokenBudgets: { low: undefined },
        });

        // The effort still goes out; only the unusable budget is dropped.
        expect(options.openai).toEqual({ reasoningEffort: 'low' });
    });
});

describe('user picks a level on a chat-template model with partial kwargs', () => {
    it('user gets baseten no args when the model declares none', () => {
        const options = optionsFor(resolution({ format: 'baseten', level: 'medium' }));

        // Without a template there is nothing to pass, but the effort still applies.
        expect(options.openaiCompatible).toEqual({ reasoningEffort: 'medium' });
    });

    it('user gets baseten the off value when reasoning is off and the model names one', () => {
        const options = optionsFor(
            resolution({
                format: 'baseten',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            })
        );

        expect(options.openaiCompatible).toEqual({ reasoningEffort: 'none' });
    });

    it('user gets baseten no effort when it is off and the model names no value', () => {
        const options = optionsFor(
            resolution({
                format: 'baseten',
                level: 'off',
                source: 'capability',
                map: {},
            })
        );

        expect(options).toEqual({});
    });

    it('user gets a template placeholder resolved to the off value', () => {
        const options = optionsFor(
            resolution({
                format: 'chat-template',
                level: 'off',
                source: 'capability',
                map: { off: 'none' },
            }),
            { chatTemplateKwargs: { level: { $var: 'thinking.effort' } } }
        );

        // An effort placeholder falls through to the off value when reasoning is off.
        expect(options.openaiCompatible).toEqual({
            chat_template_kwargs: { level: 'none' },
        });
    });

    it('user gets a template placeholder resolved to the enabled value', () => {
        const options = optionsFor(resolution({ format: 'chat-template', level: 'medium' }), {
            chatTemplateKwargs: { level: { $var: 'thinking.effort' } },
        });

        expect(options.openaiCompatible).toEqual({
            chat_template_kwargs: { level: 'medium' },
        });
    });
});

describe('user picks a level on a Google model with an unusual name', () => {
    it('user gets discrete levels for the flash-latest alias', () => {
        const options = optionsFor(
            resolution({
                format: 'google-generative',
                level: 'medium',
                modelId: 'gemini-flash-latest',
            })
        );

        expect(options.google).toEqual({
            thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: true },
        });
    });

    it('user gets discrete levels for the flash-lite alias', () => {
        const options = optionsFor(
            resolution({
                format: 'google-generative',
                level: 'low',
                modelId: 'gemini-flash-lite-latest',
            })
        );

        expect(options.google).toEqual({
            thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true },
        });
    });

    it('user gets discrete levels for a gemma model', () => {
        const options = optionsFor(
            resolution({
                format: 'google-generative',
                level: 'high',
                modelId: 'gemma-4-27b',
            })
        );

        expect(options.google).toEqual({
            thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true },
        });
    });

    it('user gets the highest level for a Google model that names an unrecognized level', () => {
        const options = optionsFor(
            resolution({
                format: 'google-generative',
                level: 'high',
                // A relay that reports a level name Google does not have.
                mapped: 'turbo',
                modelId: 'gemini-3-pro',
            })
        );

        expect(options.google).toEqual({
            thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true },
        });
    });

    it('user gets a budget for an older Google model even when the level is max', () => {
        const options = optionsFor(
            resolution({
                format: 'google-generative',
                level: 'max',
                modelId: 'gemini-2.5-flash',
            })
        );

        expect(options.google).toEqual({
            thinkingConfig: { thinkingBudget: expect.any(Number), includeThoughts: true },
        });
    });
});
