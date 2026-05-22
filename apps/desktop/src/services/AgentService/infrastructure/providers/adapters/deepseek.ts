// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createDeepSeek } from '@ai-sdk/deepseek';

import { z } from '@/utils/zod';

import { AiSdkProviderBase } from '../ai-sdk/base';
import type { ProviderApiTargets } from '../types';

const deepseekModelsSchema = z.object({
    data: z.array(
        z.object({
            id: z.string(),
        })
    ),
});

/**
 * DeepSeek 适配器。
 */
export class DeepSeekProviderAdapter extends AiSdkProviderBase {
    readonly name = 'DeepSeek';
    readonly driver = 'deepseek' as const;

    private sdkProvider = createDeepSeek({
        apiKey: this.apiKey,
        baseURL: this.getApiTargets().sdkBaseUrl || undefined,
        headers: this.getCustomHeaders(),
        fetch: this.fetch,
    });

    protected createLanguageModel(modelId: string) {
        return this.sdkProvider.chat(modelId);
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
        const parsed = deepseekModelsSchema.parse(payload);
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
