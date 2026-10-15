// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { z } from '@/utils/zod';

import { normalizeReasoningOptions, type ReasoningProtocol } from '../../../contracts/reasoning';
import { AiSdkProviderBase } from '../ai-sdk/base';
import type { ProviderApiTargets } from '../types';
import { resolveOpenAiStyleSdkBaseUrl } from '../utils';

const openAiCompatibleModelsSchema = z.object({
    data: z.array(
        z.object({
            id: z.string(),
            reasoning_options: z.unknown().optional(),
        })
    ),
});

export class MiMoProviderAdapter extends AiSdkProviderBase {
    readonly name = 'Xiaomi MiMo';
    readonly driver = 'mimo' as const;

    private readonly sdkProvider = createOpenAICompatible({
        name: 'mimo',
        apiKey: this.apiKey,
        baseURL: this.getApiTargets().sdkBaseUrl || '',
        headers: this.getCustomHeaders(),
        fetch: this.fetch,
        includeUsage: false,
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
        const parsed = openAiCompatibleModelsSchema.parse(payload);
        return parsed.data.map((model) => {
            const reasoningOptions = normalizeReasoningOptions(model.reasoning_options);
            return {
                id: model.id,
                name: model.id,
                ...(reasoningOptions.length > 0 ? { reasoningOptions } : {}),
            };
        });
    }

    /**
     * MiMo 基于 OpenAI-compatible 协议，providerOptions namespace 为 mimo。
     * 统一档位由 reasoning resolver + openai-compatible encoder 翻译。
     */
    protected override getReasoningProtocol(): ReasoningProtocol {
        return 'openai';
    }

    protected override getReasoningProviderOptionsKey(): string {
        return 'mimo';
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

        const sdkBaseUrl = resolveOpenAiStyleSdkBaseUrl(this.normalizedBaseUrl);
        return {
            normalizedBaseUrl: this.normalizedBaseUrl,
            sdkBaseUrl,
            generationTarget: `${sdkBaseUrl}/chat/completions`,
            discoveryTarget: `${sdkBaseUrl}/models`,
        };
    }
}
