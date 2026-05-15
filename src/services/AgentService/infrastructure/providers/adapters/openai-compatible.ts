// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { z } from '@/utils/zod';

import { AiSdkProviderBase } from '../ai-sdk/base';
import type { ProviderApiTargets } from '../types';

const openAiCompatibleModelsSchema = z.object({
    data: z.array(
        z.object({
            id: z.string(),
        })
    ),
});

/**
 * OpenAI-compatible 适配器。
 *
 * 使用 @ai-sdk/openai-compatible SDK，默认不发送 stream_options，
 * 兼容不支持该参数的第三方 provider（如 MiMo）。
 */
export class OpenAICompatibleProviderAdapter extends AiSdkProviderBase {
    readonly name = 'OpenAI 兼容';
    readonly driver = 'openai-compatible' as const;

    private sdkProvider = createOpenAICompatible({
        name: 'openai-compatible',
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
        return parsed.data.map((model) => ({
            id: model.id,
            name: model.id,
        }));
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

        return {
            normalizedBaseUrl: this.normalizedBaseUrl,
            sdkBaseUrl: this.normalizedBaseUrl,
            generationTarget: `${this.normalizedBaseUrl}/chat/completions`,
            discoveryTarget: `${this.normalizedBaseUrl}/models`,
        };
    }
}
