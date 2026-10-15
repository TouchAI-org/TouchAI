// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { JsonObject, JsonValue } from '../../../contracts/protocol';
import { budgetForReasoningLevel, type ReasoningProtocol } from '../../../contracts/reasoning';
import type {
    ChatTemplateKwargValue,
    ReasoningEncoderResult,
    ReasoningEncodingHints,
    ReasoningResolution,
} from './types';

function providerOptions(key: string, options: JsonObject): ReasoningEncoderResult {
    return Object.keys(options).length > 0 ? { providerOptions: { [key]: options } } : {};
}

function isEnabled(res: ReasoningResolution): boolean {
    return res.level !== 'off';
}

function supportsEffort(compat: ReasoningEncodingHints | undefined): boolean {
    return compat?.supportsReasoningEffort ?? true;
}

/** 启用档位对应的原生值（命中 map 用 map，否则用统一档位名）。 */
function effortValue(res: ReasoningResolution): string | undefined {
    return isEnabled(res) ? (res.mapped ?? res.level) : undefined;
}

/** `off` 档位对应的原生值（map.off 为 string 时）。 */
function offValue(res: ReasoningResolution): string | undefined {
    const off = res.map.off;
    return typeof off === 'string' ? off : undefined;
}

/**
 * 是否应该显式发送「关闭思考」参数。
 *
 * capability 命中或显式 passthrough 时发送；auto + 无 metadata 时不发送（R7）。
 */
function shouldEmitOff(res: ReasoningResolution): boolean {
    return res.source === 'capability' || res.mode === 'passthrough';
}

function resolveBudgetField(compat: ReasoningEncodingHints | undefined): string | undefined {
    if (compat?.tokenBudgetField) {
        return compat.tokenBudgetField;
    }
    if (compat?.supportsTokenBudget) {
        return 'thinking_token_budget';
    }
    return undefined;
}

/**
 * 顶层思考预算字段（独立于 reasoningProtocol）。
 *
 * 部分 OpenAI 兼容服务端用同一个 `max_tokens` 承载思考与回答，不设上限时
 * 思考可能吃光整个响应。
 */
function applyBudgetField(
    options: JsonObject,
    res: ReasoningResolution,
    compat: ReasoningEncodingHints | undefined
): void {
    const field = resolveBudgetField(compat);
    if (!field) {
        return;
    }
    const budget =
        res.budgetTokens ?? budgetForReasoningLevel(res.level, compat?.reasoningTokenBudgets);
    if (budget === undefined) {
        return;
    }
    options[field] = budget;
}

/** openai：默认的 reasoning_effort 编码。 */
function encodeOpenAi(res: ReasoningResolution, compat: ReasoningEncodingHints | undefined) {
    const options: JsonObject = {};
    if (isEnabled(res)) {
        if (supportsEffort(compat)) {
            options.reasoningEffort = effortValue(res);
        }
    } else if (supportsEffort(compat)) {
        const off = offValue(res);
        if (off !== undefined) {
            options.reasoningEffort = off;
        }
    }
    applyBudgetField(options, res, compat);
    return providerOptions('openai', options);
}

/** openai-responses：无状态 + 回传加密 reasoning，附带 reasoning.effort。 */
function encodeOpenAiResponses(
    res: ReasoningResolution,
    compat: ReasoningEncodingHints | undefined
) {
    const options: JsonObject = { store: false };
    if (isEnabled(res)) {
        options.reasoningEffort = effortValue(res);
        options.reasoningSummary = 'auto';
        options.include = ['reasoning.encrypted_content'];
    } else if (shouldEmitOff(res) && res.map.off !== null) {
        options.reasoningEffort = offValue(res) ?? 'none';
    }
    void compat;
    return providerOptions('openai', options);
}

/** openrouter：reasoning: { effort }。 */
function encodeOpenRouter(res: ReasoningResolution, compat: ReasoningEncodingHints | undefined) {
    const options: JsonObject = {};
    if (isEnabled(res)) {
        options.reasoning = { effort: effortValue(res) };
    } else if (shouldEmitOff(res) && res.map.off !== null) {
        options.reasoning = { effort: offValue(res) ?? 'none' };
    }
    applyBudgetField(options, res, compat);
    return providerOptions('openaiCompatible', options);
}

/** deepseek：thinking.type + reasoningEffort。 */
function encodeDeepSeek(res: ReasoningResolution, compat: ReasoningEncodingHints | undefined) {
    const options: JsonObject = {};
    if (isEnabled(res)) {
        options.thinking = { type: 'enabled' };
        if (supportsEffort(compat)) {
            options.reasoningEffort = effortValue(res);
        }
    } else if (shouldEmitOff(res) && res.map.off !== null) {
        options.thinking = { type: 'disabled' };
    }
    applyBudgetField(options, res, compat);
    return providerOptions('deepseek', options);
}

/** together：reasoning.enabled + reasoningEffort。 */
function encodeTogether(res: ReasoningResolution, compat: ReasoningEncodingHints | undefined) {
    // auto + 无 metadata：resolver 给出 level=off/source=fallback，此时不发送任何 reasoning 参数。
    if (!isEnabled(res) && !shouldEmitOff(res)) {
        return {};
    }
    const options: JsonObject = { reasoning: { enabled: isEnabled(res) } };
    if (isEnabled(res) && supportsEffort(compat)) {
        options.reasoningEffort = effortValue(res);
    }
    applyBudgetField(options, res, compat);
    return providerOptions('openaiCompatible', options);
}

/** zai：thinking.type + clear_thinking + reasoningEffort。 */
function encodeZai(res: ReasoningResolution, compat: ReasoningEncodingHints | undefined) {
    // auto + 无 metadata：resolver 给出 level=off/source=fallback，此时不发送任何 reasoning 参数。
    if (!isEnabled(res) && !shouldEmitOff(res)) {
        return {};
    }
    const options: JsonObject = {
        thinking: isEnabled(res)
            ? { type: 'enabled', clear_thinking: false }
            : { type: 'disabled' },
    };
    if (isEnabled(res) && supportsEffort(compat)) {
        options.reasoningEffort = effortValue(res);
    }
    applyBudgetField(options, res, compat);
    return providerOptions('openaiCompatible', options);
}

/** qwen：enable_thinking + reasoningEffort。 */
function encodeQwen(res: ReasoningResolution, compat: ReasoningEncodingHints | undefined) {
    // auto + 无 metadata：resolver 给出 level=off/source=fallback，此时不发送任何 reasoning 参数。
    if (!isEnabled(res) && !shouldEmitOff(res)) {
        return {};
    }
    const options: JsonObject = { enable_thinking: isEnabled(res) };
    if (isEnabled(res) && supportsEffort(compat)) {
        options.reasoningEffort = effortValue(res);
    }
    applyBudgetField(options, res, compat);
    return providerOptions('openaiCompatible', options);
}

/** qwen-chat-template：chat_template_kwargs。 */
function encodeQwenChatTemplate(
    res: ReasoningResolution,
    compat: ReasoningEncodingHints | undefined
) {
    // auto + 无 metadata：resolver 给出 level=off/source=fallback，此时不发送任何 reasoning 参数。
    if (!isEnabled(res) && !shouldEmitOff(res)) {
        return {};
    }
    const options: JsonObject = {
        chat_template_kwargs: {
            enable_thinking: isEnabled(res),
            preserve_thinking: true,
        },
    };
    applyBudgetField(options, res, compat);
    return providerOptions('openaiCompatible', options);
}

/** chat-template：由 compat.chatTemplateKwargs 驱动。 */
function encodeChatTemplate(res: ReasoningResolution, compat: ReasoningEncodingHints | undefined) {
    const options: JsonObject = {};
    const kwargs = buildChatTemplateValues(res, compat?.chatTemplateKwargs, compat);
    if (kwargs) {
        options.chat_template_kwargs = kwargs;
    }
    applyBudgetField(options, res, compat);
    return providerOptions('openaiCompatible', options);
}

/** baseten：chat_template_args + reasoningEffort。 */
function encodeBaseten(res: ReasoningResolution, compat: ReasoningEncodingHints | undefined) {
    const options: JsonObject = {};
    const args = buildChatTemplateValues(res, compat?.chatTemplateArgs, compat);
    if (args) {
        options.chat_template_args = args;
    }
    if (supportsEffort(compat)) {
        const value = isEnabled(res) ? effortValue(res) : offValue(res);
        if (value !== undefined) {
            options.reasoningEffort = value;
        }
    }
    applyBudgetField(options, res, compat);
    return providerOptions('openaiCompatible', options);
}

/** string-thinking：thinking 直接是字符串。 */
function encodeStringThinking(
    res: ReasoningResolution,
    compat: ReasoningEncodingHints | undefined
) {
    const options: JsonObject = {};
    if (isEnabled(res)) {
        options.thinking = effortValue(res);
    } else if (shouldEmitOff(res) && res.map.off !== null) {
        options.thinking = offValue(res) ?? 'none';
    }
    applyBudgetField(options, res, compat);
    return providerOptions('openaiCompatible', options);
}

/** ant-ling：reasoning.effort（仅当 map 命中字符串）。 */
function encodeAntLing(res: ReasoningResolution, compat: ReasoningEncodingHints | undefined) {
    const options: JsonObject = {};
    if (isEnabled(res) && typeof res.mapped === 'string') {
        options.reasoning = { effort: res.mapped };
    }
    applyBudgetField(options, res, compat);
    return providerOptions('openaiCompatible', options);
}

/** 把统一档位映射成 Anthropic 自适应思考的 effort。 */
function mapReasoningLevelToEffort(res: ReasoningResolution): string {
    if (typeof res.mapped === 'string') {
        return res.mapped;
    }
    switch (res.level) {
        case 'minimal':
        case 'low':
            return 'low';
        case 'medium':
            return 'medium';
        default:
            return 'high';
    }
}

/** anthropic-messages：自适应思考用 effort，老模型用 budgetTokens。 */
function encodeAnthropicMessages(
    res: ReasoningResolution,
    compat: ReasoningEncodingHints | undefined
) {
    const options: JsonObject = {};
    if (!isEnabled(res)) {
        if (shouldEmitOff(res)) {
            options.thinking = { type: 'disabled' };
        }
    } else if (compat?.forceAdaptiveThinking) {
        options.thinking = { type: 'adaptive', display: 'summarized' };
        options.effort = mapReasoningLevelToEffort(res);
    } else {
        const budget =
            res.budgetTokens ?? budgetForReasoningLevel(res.level, compat?.reasoningTokenBudgets);
        options.thinking =
            budget === undefined ? { type: 'enabled' } : { type: 'enabled', budgetTokens: budget };
    }
    return providerOptions('anthropic', options);
}

const GOOGLE_REASONING_LEVEL = {
    minimal: 'MINIMAL',
    low: 'LOW',
    medium: 'MEDIUM',
    high: 'HIGH',
} as const;

/** Gemini 3 / Gemma 4 等使用离散 thinkingLevel，其余用 thinkingBudget。 */
function usesGoogleReasoningLevel(modelId: string): boolean {
    const id = modelId.toLowerCase();
    return (
        /gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) ||
        id === 'gemini-flash-latest' ||
        id === 'gemini-flash-lite-latest' ||
        /gemma-?4/.test(id)
    );
}

function resolveGoogleReasoningLevel(
    res: ReasoningResolution
): keyof typeof GOOGLE_REASONING_LEVEL {
    const mapped = typeof res.mapped === 'string' ? res.mapped.toLowerCase() : res.level;
    switch (mapped) {
        case 'minimal':
        case 'low':
        case 'medium':
        case 'high':
            return mapped;
        default:
            return 'high';
    }
}

/** google-generative：thinkingLevel 或 thinkingBudget。 */
function encodeGoogleGenerative(
    res: ReasoningResolution,
    compat: ReasoningEncodingHints | undefined
) {
    const options: JsonObject = {};
    if (!isEnabled(res)) {
        if (shouldEmitOff(res)) {
            options.thinkingConfig = { thinkingBudget: 0, includeThoughts: false };
        }
    } else if (usesGoogleReasoningLevel(res.modelId)) {
        options.thinkingConfig = {
            thinkingLevel: GOOGLE_REASONING_LEVEL[resolveGoogleReasoningLevel(res)],
            includeThoughts: true,
        };
    } else {
        const budget =
            res.budgetTokens ?? budgetForReasoningLevel(res.level, compat?.reasoningTokenBudgets);
        options.thinkingConfig = {
            thinkingBudget: budget ?? -1,
            includeThoughts: true,
        };
    }
    return providerOptions('google', options);
}

function buildChatTemplateValues(
    res: ReasoningResolution,
    values: Record<string, ChatTemplateKwargValue> | undefined,
    compat: ReasoningEncodingHints | undefined
): JsonObject | undefined {
    if (!values) {
        return undefined;
    }

    const resolved: JsonObject = {};
    for (const [key, value] of Object.entries(values)) {
        const item = resolveChatTemplateValue(res, value, compat);
        if (item !== undefined) {
            resolved[key] = item;
        }
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function resolveChatTemplateValue(
    res: ReasoningResolution,
    value: ChatTemplateKwargValue,
    compat: ReasoningEncodingHints | undefined
): JsonValue | undefined {
    if (typeof value !== 'object' || value === null) {
        return value;
    }

    const enabled = isEnabled(res);
    if (!enabled && value.omitWhenOff) {
        return undefined;
    }
    if (value.$var === 'thinking.enabled') {
        return enabled;
    }
    if (value.$var === 'thinking.budget') {
        return (
            res.budgetTokens ?? budgetForReasoningLevel(res.level, compat?.reasoningTokenBudgets)
        );
    }
    return enabled ? effortValue(res) : offValue(res);
}

type Encoder = (
    res: ReasoningResolution,
    compat: ReasoningEncodingHints | undefined
) => ReasoningEncoderResult;

const encoders: Record<ReasoningProtocol, Encoder> = {
    openai: encodeOpenAi,
    openrouter: encodeOpenRouter,
    deepseek: encodeDeepSeek,
    together: encodeTogether,
    baseten: encodeBaseten,
    zai: encodeZai,
    qwen: encodeQwen,
    'qwen-chat-template': encodeQwenChatTemplate,
    'chat-template': encodeChatTemplate,
    'string-thinking': encodeStringThinking,
    'ant-ling': encodeAntLing,
    'openai-responses': encodeOpenAiResponses,
    'anthropic-messages': encodeAnthropicMessages,
    'google-generative': encodeGoogleGenerative,
};

/**
 * 按 format 把推理结果编码成出站参数。
 *
 * mode=off 时完全不发 reasoning 参数；无 metadata 且 mode=auto 时 resolver 会
 * 给出 `level: 'off'` + `source: 'fallback'`，各 encoder 据此不发送 reasoning 参数（R7）。
 */
export function encodeReasoning(
    resolution: ReasoningResolution,
    compat?: ReasoningEncodingHints
): ReasoningEncoderResult {
    if (resolution.source === 'off') {
        return {};
    }

    return encoders[resolution.format](resolution, compat);
}
