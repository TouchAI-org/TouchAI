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

const OPENAI_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const DEEPSEEK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const ALL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const unsupportedReasoningCapabilities: ProviderReasoningCapabilities = {
    supportsReasoning: false,
    supportedEfforts: [],
    parsesReasoningContent: false,
};

const providerReasoningCapabilitiesByDriver: Record<ProviderDriver, ProviderReasoningCapabilities> =
    {
        openai: {
            supportsReasoning: true,
            supportedEfforts: OPENAI_EFFORTS,
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
    driver: ProviderDriver
): ProviderReasoningCapabilities {
    return providerReasoningCapabilitiesByDriver[driver];
}

export function getDefaultReasoningEffort(
    driver: ProviderDriver | undefined
): ReasoningEffort | undefined {
    if (!driver) {
        return undefined;
    }

    return getProviderReasoningCapabilities(driver).defaultEffort;
}

export function resolveReasoningEffort(
    driver: ProviderDriver | undefined,
    requested?: unknown
): ReasoningEffort | undefined {
    if (!driver) {
        return undefined;
    }

    const capabilities = getProviderReasoningCapabilities(driver);
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
    requested?: unknown
): Record<string, JsonObject> | undefined {
    if (!driver) {
        return undefined;
    }

    const capabilities = getProviderReasoningCapabilities(driver);
    const effort = resolveReasoningEffort(driver, requested);

    if (!capabilities.transport || !effort) {
        return undefined;
    }

    return {
        [capabilities.transport]: {
            reasoningEffort: effort,
        },
    };
}
