// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { JsonObject } from '../../../contracts/protocol';
import type { ReasoningEncoderResult, ReasoningNative, ReasoningPlan } from './types';

function effortOf(native: ReasoningNative): string | undefined {
    return native.kind === 'effort' ? native.effort : undefined;
}

/**
 * openai-chat：把统一档位编码成 `reasoningEffort`。
 *
 * `native.kind === 'none'` 表示「没有可用的 reasoning 信号」（无 metadata 且
 * mode=auto，或显式关闭），此时不发送任何 reasoning 参数（R7）。显式要求
 * `none` 且模型声明支持 `none` 时，resolver 会给出 `kind: 'effort'` 的 `none`。
 */
function encodeOpenAiChat(plan: ReasoningPlan): ReasoningEncoderResult {
    const effort = effortOf(plan.native);
    if (!effort) {
        return {};
    }
    return { providerOptions: { openai: { reasoningEffort: effort } } };
}

/**
 * openai-responses：无状态 + 回传加密 reasoning，附带 reasoningEffort。
 *
 * store:false 让官方 Responses 不落库；include reasoning.encrypted_content
 * 让多轮工具调用可以回放思考内容。没有 reasoning 信号时只保留无状态设置。
 */
function encodeOpenAiResponses(plan: ReasoningPlan): ReasoningEncoderResult {
    const openai: JsonObject = { store: false };

    const effort = effortOf(plan.native);
    if (effort) {
        openai.reasoningSummary = 'auto';
        openai.include = ['reasoning.encrypted_content'];
        openai.reasoningEffort = effort;
    } else if (plan.native.kind === 'toggle' || plan.native.kind === 'budget') {
        openai.reasoningSummary = 'auto';
        openai.include = ['reasoning.encrypted_content'];
    }

    return { providerOptions: { openai } };
}

/**
 * deepseek-chat：none → thinking disabled；其余 → thinking enabled + reasoningEffort。
 *
 * 同时发送 thinking 与 reasoningEffort，和 opencode 的 deepseekChat 协议保持一致。
 */
function encodeDeepSeekChat(plan: ReasoningPlan): ReasoningEncoderResult {
    if (plan.native.kind === 'none') {
        return {};
    }

    if (plan.native.kind === 'toggle') {
        return {
            providerOptions: {
                deepseek: { thinking: { type: plan.native.enabled ? 'enabled' : 'disabled' } },
            },
        };
    }

    if (plan.native.kind === 'budget') {
        return { providerOptions: { deepseek: { thinking: { type: 'enabled' } } } };
    }

    return {
        providerOptions: {
            deepseek: {
                reasoningEffort: plan.native.effort,
                thinking: { type: 'enabled' },
            },
        },
    };
}

/**
 * anthropic-messages：effort → adaptive thinking + effort；budget → manual thinking。
 */
function encodeAnthropicMessages(plan: ReasoningPlan): ReasoningEncoderResult {
    if (plan.native.kind === 'none') {
        return {};
    }

    if (plan.native.kind === 'toggle') {
        return {
            providerOptions: {
                anthropic: {
                    thinking: plan.native.enabled
                        ? { type: 'adaptive', display: 'summarized' }
                        : { type: 'disabled' },
                },
            },
        };
    }

    if (plan.native.kind === 'budget') {
        return {
            providerOptions: {
                anthropic: {
                    thinking: { type: 'enabled', budgetTokens: plan.native.tokens },
                },
            },
        };
    }

    return {
        providerOptions: {
            anthropic: {
                thinking: { type: 'adaptive', display: 'summarized' },
                effort: plan.native.effort,
            },
        },
    };
}

type GoogleThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

function toGoogleThinkingLevel(effort: string): GoogleThinkingLevel {
    if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high') {
        return effort;
    }
    if (effort === 'xhigh' || effort === 'max') {
        return 'high';
    }
    return 'medium';
}

/**
 * google-generative：effort → thinkingLevel；budget/toggle → thinkingBudget。
 */
function encodeGoogleGenerative(plan: ReasoningPlan): ReasoningEncoderResult {
    if (plan.native.kind === 'none') {
        return {};
    }

    if (plan.native.kind === 'toggle') {
        return {
            providerOptions: {
                google: {
                    thinkingConfig: plan.native.enabled
                        ? { thinkingBudget: -1, includeThoughts: true }
                        : { thinkingBudget: 0, includeThoughts: false },
                },
            },
        };
    }

    if (plan.native.kind === 'budget') {
        return {
            providerOptions: {
                google: {
                    thinkingConfig: {
                        thinkingBudget: plan.native.tokens,
                        includeThoughts: true,
                    },
                },
            },
        };
    }

    if (plan.native.effort === 'none') {
        return {
            providerOptions: {
                google: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
            },
        };
    }

    return {
        providerOptions: {
            google: {
                thinkingConfig: {
                    thinkingLevel: toGoogleThinkingLevel(plan.native.effort),
                    includeThoughts: true,
                },
            },
        },
    };
}

/**
 * openai-compatible：透传统一档位，由中转站自行解释。
 */
function encodeOpenAiCompatible(plan: ReasoningPlan): ReasoningEncoderResult {
    const effort = effortOf(plan.native);
    if (!effort) {
        return {};
    }
    return { providerOptions: { openaiCompatible: { reasoningEffort: effort } } };
}

const encoders = {
    'openai-chat': encodeOpenAiChat,
    'openai-responses': encodeOpenAiResponses,
    'deepseek-chat': encodeDeepSeekChat,
    'anthropic-messages': encodeAnthropicMessages,
    'google-generative': encodeGoogleGenerative,
    'openai-compatible': encodeOpenAiCompatible,
} as const;

/**
 * 按协议把 ReasoningPlan 编码成出站参数。
 *
 * mode=off 时完全不发 reasoning 参数。无 metadata 且 mode=auto 时 resolver 会
 * 给出 `kind: 'none'`，各 encoder 据此不发送 reasoning 参数（R7）。
 */
export function encodeReasoning(plan: ReasoningPlan): ReasoningEncoderResult {
    if (plan.source === 'off') {
        return {};
    }

    return encoders[plan.protocol](plan);
}
