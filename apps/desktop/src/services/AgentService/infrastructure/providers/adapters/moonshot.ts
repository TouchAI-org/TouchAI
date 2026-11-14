// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createMoonshotAI, type MoonshotAILanguageModelOptions } from '@ai-sdk/moonshotai';

import { z } from '@/utils/zod';

import {
    deriveReasoningLevelMap,
    type ReasoningProtocol,
    type SelectableReasoningLevel,
} from '../../../contracts/reasoning';
import { AiSdkProviderBase } from '../ai-sdk/base';
import { toModelInfo } from '../modelList';
import type { ReasoningEncodingHints } from '../reasoning';
import type { ProviderApiTargets, ProviderReasoningInput } from '../types';

const moonshotReasoningEfforts = new Set<string>(['low', 'high', 'max'] satisfies NonNullable<
    MoonshotAILanguageModelOptions['reasoningEffort']
>[]);

const moonshotModelsSchema = z.object({
    data: z.array(
        z
            .object({
                id: z.string(),
            })
            .loose()
    ),
});

function resolveMoonshotSdkBaseUrl(normalizedBaseUrl: string): string {
    if (!normalizedBaseUrl) {
        return '';
    }

    try {
        const { pathname } = new URL(normalizedBaseUrl);
        return pathname && pathname !== '/' ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    } catch {
        return `${normalizedBaseUrl}/v1`;
    }
}

/**
 * Moonshot 适配器。
 */
export class MoonshotProviderAdapter extends AiSdkProviderBase {
    readonly name = 'Moonshot';
    readonly driver = 'moonshot' as const;

    private sdkProvider = createMoonshotAI({
        apiKey: this.apiKey,
        baseURL: this.getApiTargets().sdkBaseUrl || undefined,
        headers: this.getCustomHeaders(),
        fetch: this.fetch,
    });

    protected createLanguageModel(modelId: string) {
        return this.sdkProvider.chatModel(modelId);
    }

    protected getDiscoveryHeaders(): Record<string, string> {
        return {
            ...(this.apiKey
                ? {
                      Authorization: `Bearer ${this.apiKey}`,
                  }
                : {}),
            ...this.getCustomHeaders(),
        };
    }

    protected parseModelList(payload: unknown) {
        const parsed = moonshotModelsSchema.parse(payload);
        return parsed.data.map((model) => toModelInfo(model, { id: model.id }));
    }

    protected override getReasoningProtocol(): ReasoningProtocol {
        return 'deepseek';
    }

    protected override getReasoningProviderOptionsKey(): string {
        return 'moonshotai';
    }

    protected override getReasoningEncodingHints(
        options: ProviderReasoningInput
    ): ReasoningEncodingHints {
        return {
            supportsReasoningEffort:
                !['kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed'].includes(
                    options.model
                ) && !options.model.startsWith('moonshot-v1-'),
        };
    }

    protected override filterReasoningLevels(
        levels: SelectableReasoningLevel[],
        options: ProviderReasoningInput
    ): SelectableReasoningLevel[] {
        if (options.model.startsWith('moonshot-v1-')) return [];
        const map = deriveReasoningLevelMap(options.reasoningOptions);
        return levels.filter((level) => {
            if (level === 'off')
                return !['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed'].includes(
                    options.model
                );
            return moonshotReasoningEfforts.has(map[level] ?? level);
        });
    }

    getApiTargets(): ProviderApiTargets {
        if (!this.normalizedBaseUrl) {
            return {
                normalizedBaseUrl: '',
                sdkBaseUrl: '',
                generationTarget: '',
                discoveryTarget: '',
            };
        }

        const sdkBaseUrl = resolveMoonshotSdkBaseUrl(this.normalizedBaseUrl);
        return {
            normalizedBaseUrl: this.normalizedBaseUrl,
            sdkBaseUrl,
            generationTarget: `${sdkBaseUrl}/chat/completions`,
            discoveryTarget: `${sdkBaseUrl}/models`,
        };
    }
}
