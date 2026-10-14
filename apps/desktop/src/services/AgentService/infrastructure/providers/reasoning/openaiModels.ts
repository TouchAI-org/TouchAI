// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ReasoningLevel, ReasoningOption } from '../../../contracts/reasoning';

/**
 * OpenAI 官方模型支持的 effort 随模型版本变化。metadata 缺失时用这张表兜底，
 * 把 TouchAI 统一档位映射到该模型最近的受支持档位。
 */
const OPENAI_GPT5_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
const OPENAI_GPT5_1_LEVELS = ['none', 'low', 'medium', 'high'] as const;
const OPENAI_GPT5_2_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
const OPENAI_GPT5_4_PRO_LEVELS = ['medium', 'high', 'xhigh'] as const;
const OPENAI_GPT5_6_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const OPENAI_GPT6_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const OPENAI_GPT6_SOL_LUNA_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const OPENAI_O_SERIES_LEVELS = ['low', 'medium', 'high'] as const;

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

export function getOpenAiSupportedLevels(modelId: string): readonly ReasoningLevel[] | undefined {
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

/** 把硬编码模型表包装成 capability，供 resolver 统一处理。 */
export function getOpenAiReasoningCapability(modelId: string): ReasoningOption[] {
    const supported = getOpenAiSupportedLevels(modelId);
    if (!supported) {
        return [];
    }
    return [{ type: 'effort', values: [...supported] }];
}

/**
 * GPT-6 Sol/Luna 在 Chat Completions 下只有 `none` 支持 function calling，
 * 因此带工具的请求必须使用 `none`。Responses API 没有该限制。
 */
export function isOpenAiGpt6SolOrLuna(modelId: string): boolean {
    const gptVersion = parseOpenAiGptVersion(normalizeOpenAiModelId(modelId));
    if (gptVersion?.major !== 6 || gptVersion.minor !== undefined) {
        return false;
    }

    return Boolean(gptVersion.variant?.startsWith('sol') || gptVersion.variant?.startsWith('luna'));
}
