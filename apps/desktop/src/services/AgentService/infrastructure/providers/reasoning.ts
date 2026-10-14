// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderDriver } from '@database/schema';

import type { JsonObject } from '../../contracts/protocol';
import type { ReasoningEffort } from '../../contracts/reasoning';

export type ReasoningTransport = 'openai' | 'openai-compatible' | 'deepseek' | 'mimo';

export interface ProviderReasoningCapabilities {
    supportsReasoning: boolean;
    supportedEfforts: readonly ReasoningEffort[];
    defaultEffort?: ReasoningEffort;
    transport?: ReasoningTransport;
    parsesReasoningContent: boolean;
}

const OPENAI_DRIVER_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const OPENAI_O_SERIES_EFFORTS = ['low', 'medium', 'high'] as const;
const OPENAI_GPT5_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
const OPENAI_GPT5_1_EFFORTS = ['none', 'low', 'medium', 'high'] as const;
const OPENAI_GPT5_2_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
const OPENAI_GPT5_4_PRO_EFFORTS = ['medium', 'high', 'xhigh'] as const;
const OPENAI_GPT5_6_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const OPENAI_GPT6_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const OPENAI_GPT6_SOL_LUNA_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const DEEPSEEK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const ALL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const unsupportedReasoningCapabilities: ProviderReasoningCapabilities = {
    supportsReasoning: false,
    supportedEfforts: [],
    parsesReasoningContent: false,
};

function createOpenAiCapabilities(
    supportedEfforts: readonly ReasoningEffort[],
    defaultEffort: ReasoningEffort
): ProviderReasoningCapabilities {
    return {
        supportsReasoning: true,
        supportedEfforts,
        defaultEffort,
        transport: 'openai',
        parsesReasoningContent: false,
    };
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

/**
 * OpenAI 官方模型的 reasoning effort 上限随模型版本变化。这里只覆盖
 * 已知的 reasoning 模型族；未知模型不发送 effort，避免把无效参数透传。
 */
function getOpenAiReasoningCapabilities(
    modelId: string
): ProviderReasoningCapabilities | undefined {
    const normalizedModelId = normalizeOpenAiModelId(modelId);
    const gptVersion = parseOpenAiGptVersion(normalizedModelId);

    if (gptVersion) {
        if (gptVersion.variant?.startsWith('chat')) {
            return undefined;
        }

        if (gptVersion.major >= 6) {
            if (gptVersion.variant?.startsWith('sol') || gptVersion.variant?.startsWith('luna')) {
                return createOpenAiCapabilities(OPENAI_GPT6_SOL_LUNA_EFFORTS, 'max');
            }
            return createOpenAiCapabilities(OPENAI_GPT6_EFFORTS, 'max');
        }

        if (gptVersion.major === 5) {
            if (gptVersion.minor === 6) {
                return createOpenAiCapabilities(OPENAI_GPT5_6_EFFORTS, 'max');
            }
            if (gptVersion.minor === 4 && gptVersion.variant?.startsWith('pro')) {
                return createOpenAiCapabilities(OPENAI_GPT5_4_PRO_EFFORTS, 'xhigh');
            }
            if (gptVersion.minor === 2 || gptVersion.minor === 4 || gptVersion.minor === 5) {
                return createOpenAiCapabilities(OPENAI_GPT5_2_EFFORTS, 'xhigh');
            }
            if (gptVersion.minor === 1) {
                return createOpenAiCapabilities(OPENAI_GPT5_1_EFFORTS, 'high');
            }
            if (gptVersion.minor === undefined) {
                return createOpenAiCapabilities(OPENAI_GPT5_EFFORTS, 'high');
            }
        }
    }

    if (/^o\d+(?:-|$)/.test(normalizedModelId)) {
        return createOpenAiCapabilities(OPENAI_O_SERIES_EFFORTS, 'high');
    }

    return undefined;
}

const providerReasoningCapabilitiesByDriver: Record<ProviderDriver, ProviderReasoningCapabilities> =
    {
        openai: {
            supportsReasoning: true,
            supportedEfforts: OPENAI_DRIVER_EFFORTS,
            defaultEffort: 'xhigh',
            transport: 'openai',
            parsesReasoningContent: false,
        },
        'openai-compatible': {
            supportsReasoning: true,
            supportedEfforts: ALL_EFFORTS,
            defaultEffort: 'max',
            transport: 'openai-compatible',
            parsesReasoningContent: true,
        },
        anthropic: unsupportedReasoningCapabilities,
        'anthropic-compatible': unsupportedReasoningCapabilities,
        google: unsupportedReasoningCapabilities,
        deepseek: {
            supportsReasoning: true,
            supportedEfforts: DEEPSEEK_EFFORTS,
            defaultEffort: 'max',
            transport: 'deepseek',
            parsesReasoningContent: true,
        },
        xai: unsupportedReasoningCapabilities,
        moonshot: unsupportedReasoningCapabilities,
        alibaba: unsupportedReasoningCapabilities,
        minimax: unsupportedReasoningCapabilities,
        zhipu: unsupportedReasoningCapabilities,
        mimo: {
            supportsReasoning: true,
            supportedEfforts: ALL_EFFORTS,
            defaultEffort: 'max',
            transport: 'mimo',
            parsesReasoningContent: true,
        },
    };

export function getProviderReasoningCapabilities(
    driver: ProviderDriver,
    modelId?: string
): ProviderReasoningCapabilities {
    if (driver === 'openai' && modelId) {
        return getOpenAiReasoningCapabilities(modelId) ?? unsupportedReasoningCapabilities;
    }

    return providerReasoningCapabilitiesByDriver[driver];
}

export function getDefaultReasoningEffort(
    driver: ProviderDriver | undefined,
    modelId?: string
): ReasoningEffort | undefined {
    if (!driver) {
        return undefined;
    }

    return getProviderReasoningCapabilities(driver, modelId).defaultEffort;
}

export function resolveReasoningEffort(
    driver: ProviderDriver | undefined,
    requested?: unknown,
    modelId?: string
): ReasoningEffort | undefined {
    if (!driver) {
        return undefined;
    }

    const capabilities = getProviderReasoningCapabilities(driver, modelId);
    if (!capabilities.supportsReasoning || !capabilities.defaultEffort) {
        return undefined;
    }

    if (
        typeof requested === 'string' &&
        capabilities.supportedEfforts.some((effort) => effort === requested)
    ) {
        return requested as ReasoningEffort;
    }

    return capabilities.defaultEffort;
}

export function buildReasoningProviderOptions(
    driver: ProviderDriver | undefined,
    requested?: unknown,
    modelId?: string
): Record<string, JsonObject> | undefined {
    if (!driver) {
        return undefined;
    }

    const capabilities = getProviderReasoningCapabilities(driver, modelId);
    const effort = resolveReasoningEffort(driver, requested, modelId);

    if (!capabilities.transport || !effort) {
        return undefined;
    }

    return {
        [capabilities.transport]: {
            reasoningEffort: effort,
        },
    };
}
