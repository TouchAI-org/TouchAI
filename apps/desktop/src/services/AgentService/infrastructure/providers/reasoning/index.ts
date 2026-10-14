// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { JsonObject } from '../../../contracts/protocol';
import {
    DEFAULT_REASONING_LEVEL,
    type ReasoningLevel,
    type ReasoningOption,
} from '../../../contracts/reasoning';
import { getOpenAiReasoningCapability, isOpenAiGpt6SolOrLuna } from './openaiModels';
import { encodeReasoning } from './protocols';
import { resolveReasoning } from './resolver';
import type { ReasoningNative } from './types';

export {
    getOpenAiReasoningCapability,
    getOpenAiSupportedLevels,
    isOpenAiGpt6SolOrLuna,
} from './openaiModels';
export { encodeReasoning } from './protocols';
export { clampToSupportedLevel, resolveReasoning } from './resolver';
export type {
    ReasoningEncoderResult,
    ReasoningNative,
    ReasoningPlan,
    ResolveReasoningInput,
} from './types';

export type OpenAiReasoningEffort = ReasoningLevel;
export type DeepSeekReasoningEffort = Extract<ReasoningLevel, 'low' | 'high' | 'max'>;

/** DeepSeek 官方能力：toggle + effort low/high/max。 */
export const DEEPSEEK_REASONING_CAPABILITY: ReasoningOption[] = [
    { type: 'toggle' },
    { type: 'effort', values: ['low', 'high', 'max'] },
];

function effortOf(native: ReasoningNative): string | undefined {
    return native.kind === 'effort' ? native.effort : undefined;
}

function resolveRequestedReasoningLevel(level: ReasoningLevel | undefined): ReasoningLevel {
    return level ?? DEFAULT_REASONING_LEVEL;
}

/**
 * OpenAI 官方模型支持的 effort 随模型版本变化。这里把 TouchAI
 * 统一档位映射到该模型最近的受支持档位，未知或非 reasoning 模型不发送参数。
 *
 * GPT-6 Sol/Luna 在 Chat Completions 下只有 `none` 支持 function calling，
 * 因此带工具的请求必须使用 `none`。
 */
export function translateOpenAiReasoningLevel(
    level: ReasoningLevel | undefined,
    modelId: string,
    hasTools = false
): OpenAiReasoningEffort | undefined {
    if (hasTools && isOpenAiGpt6SolOrLuna(modelId)) {
        return 'none';
    }

    const capability = getOpenAiReasoningCapability(modelId);
    if (capability.length === 0) {
        return undefined;
    }

    const plan = resolveReasoning({
        level,
        capability,
        protocol: 'openai-chat',
        mode: 'auto',
        modelId,
        hasTools,
    });

    return effortOf(plan.native) as OpenAiReasoningEffort | undefined;
}

/**
 * OpenAI-compatible 中转站由上游决定具体语义，TouchAI 只做统一档位透传。
 */
export function translateOpenAiCompatibleReasoningLevel(
    level: ReasoningLevel | undefined
): ReasoningLevel {
    return resolveRequestedReasoningLevel(level);
}

/**
 * DeepSeek 的规范值只有 low / high / max；medium 和 xhigh 在驱动层归一化。
 */
export function translateDeepSeekReasoningOptions(
    level: ReasoningLevel | undefined
): JsonObject | undefined {
    const plan = resolveReasoning({
        level,
        capability: DEEPSEEK_REASONING_CAPABILITY,
        protocol: 'deepseek-chat',
        mode: 'auto',
        modelId: 'deepseek',
        hasTools: false,
    });
    const encoded = encodeReasoning(plan);
    return encoded.providerOptions?.deepseek;
}

/**
 * MiMo 使用自己的 OpenAI-compatible provider key，当前按统一档位透传。
 */
export function translateMimoReasoningLevel(level: ReasoningLevel | undefined): ReasoningLevel {
    return resolveRequestedReasoningLevel(level);
}
