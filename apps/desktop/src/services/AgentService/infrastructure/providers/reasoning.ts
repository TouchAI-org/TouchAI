// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { JsonObject } from '../../contracts/protocol';
import {
    DEFAULT_REASONING_LEVEL,
    REASONING_LEVELS,
    type ReasoningLevel,
} from '../../contracts/reasoning';

export type OpenAiReasoningEffort = ReasoningLevel;
export type DeepSeekReasoningEffort = Extract<ReasoningLevel, 'low' | 'high' | 'max'>;

const OPENAI_GPT5_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
const OPENAI_GPT5_1_LEVELS = ['none', 'low', 'medium', 'high'] as const;
const OPENAI_GPT5_2_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
const OPENAI_GPT5_4_PRO_LEVELS = ['medium', 'high', 'xhigh'] as const;
const OPENAI_GPT5_6_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const OPENAI_GPT6_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const OPENAI_GPT6_SOL_LUNA_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const OPENAI_O_SERIES_LEVELS = ['low', 'medium', 'high'] as const;

const DEEPSEEK_LEVEL_MAP: Record<ReasoningLevel, DeepSeekReasoningEffort | null> = {
    none: null,
    minimal: 'low',
    low: 'low',
    medium: 'high',
    high: 'high',
    xhigh: 'max',
    max: 'max',
};

function resolveRequestedReasoningLevel(level: ReasoningLevel | undefined): ReasoningLevel {
    return level ?? DEFAULT_REASONING_LEVEL;
}

const reasoningLevelIndex = new Map<ReasoningLevel, number>(
    REASONING_LEVELS.map((level, index) => [level, index])
);

function clampToSupportedLevel(
    requested: ReasoningLevel,
    supported: readonly ReasoningLevel[]
): ReasoningLevel | undefined {
    const requestedIndex = reasoningLevelIndex.get(requested);
    if (requestedIndex === undefined || supported.length === 0) {
        return undefined;
    }

    const firstSupported = supported[0];
    if (!firstSupported) {
        return undefined;
    }

    let nearest: ReasoningLevel = firstSupported;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of supported) {
        const candidateIndex = reasoningLevelIndex.get(candidate);
        if (candidateIndex === undefined) {
            continue;
        }

        const distance = Math.abs(candidateIndex - requestedIndex);
        const nearestIndex = reasoningLevelIndex.get(nearest) ?? 0;
        if (
            distance < nearestDistance ||
            (distance === nearestDistance && candidateIndex > nearestIndex)
        ) {
            nearest = candidate;
            nearestDistance = distance;
        }
    }

    return nearest;
}

interface OpenAiGptVersion {
    major: number;
    minor?: number;
    variant?: string;
}

function parseOpenAiGptVersion(modelId: string): OpenAiGptVersion | undefined {
    const match = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(modelId);
    if (!match) {
        return undefined;
    }

    return {
        major: Number(match[1]),
        minor: match[2] ? Number(match[2]) : undefined,
        variant: match[3],
    };
}

function normalizeOpenAiModelId(modelId: string): string {
    const normalized = modelId.trim().toLowerCase();
    const slashIndex = normalized.lastIndexOf('/');
    return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function getOpenAiSupportedLevels(modelId: string): readonly ReasoningLevel[] | undefined {
    const normalizedModelId = normalizeOpenAiModelId(modelId);
    const gptVersion = parseOpenAiGptVersion(normalizedModelId);

    if (gptVersion) {
        if (gptVersion.variant?.startsWith('chat')) {
            return undefined;
        }

        if (gptVersion.major >= 6) {
            if (gptVersion.variant?.startsWith('sol') || gptVersion.variant?.startsWith('luna')) {
                return OPENAI_GPT6_SOL_LUNA_LEVELS;
            }
            return OPENAI_GPT6_LEVELS;
        }

        if (gptVersion.major === 5) {
            if (gptVersion.minor === 6) {
                return OPENAI_GPT5_6_LEVELS;
            }
            if (gptVersion.minor === 4 && gptVersion.variant?.startsWith('pro')) {
                return OPENAI_GPT5_4_PRO_LEVELS;
            }
            if (gptVersion.minor === 2 || gptVersion.minor === 4 || gptVersion.minor === 5) {
                return OPENAI_GPT5_2_LEVELS;
            }
            if (gptVersion.minor === 1) {
                return OPENAI_GPT5_1_LEVELS;
            }
            if (gptVersion.minor === undefined) {
                return OPENAI_GPT5_LEVELS;
            }
        }
    }

    if (/^o\d+(?:-|$)/.test(normalizedModelId)) {
        return OPENAI_O_SERIES_LEVELS;
    }

    return undefined;
}

function isOpenAiGpt6SolOrLuna(modelId: string): boolean {
    const gptVersion = parseOpenAiGptVersion(normalizeOpenAiModelId(modelId));
    if (gptVersion?.major !== 6 || gptVersion.minor !== undefined) {
        return false;
    }

    return Boolean(gptVersion.variant?.startsWith('sol') || gptVersion.variant?.startsWith('luna'));
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

    const supported = getOpenAiSupportedLevels(modelId);
    if (!supported) {
        return undefined;
    }

    return clampToSupportedLevel(resolveRequestedReasoningLevel(level), supported) as
        | OpenAiReasoningEffort
        | undefined;
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
    const resolved = resolveRequestedReasoningLevel(level);
    const reasoningEffort = DEEPSEEK_LEVEL_MAP[resolved];

    if (!reasoningEffort) {
        return { thinking: { type: 'disabled' } };
    }

    return { reasoningEffort };
}

/**
 * MiMo 使用自己的 OpenAI-compatible provider key，当前按统一档位透传。
 */
export function translateMimoReasoningLevel(level: ReasoningLevel | undefined): ReasoningLevel {
    return resolveRequestedReasoningLevel(level);
}
