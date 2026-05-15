// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createAnthropic } from '@ai-sdk/anthropic';

import { z } from '@/utils/zod';

import { AiSdkProviderBase } from '../ai-sdk/base';
import type { ProviderApiTargets } from '../types';

const anthropicCompatibleModelsSchema = z.object({
    data: z.array(
        z.object({
            id: z.string(),
            display_name: z.string().optional(),
            displayName: z.string().optional(),
        })
    ),
});

/**
 * Anthropic-compatible 适配器。
 *
 * 用于第三方 Anthropic 兼容 provider。
 * 与官方适配器的区别：不自动补 /v1 路径，不发送 anthropic-version header。
 */
export class AnthropicCompatibleProviderAdapter extends AiSdkProviderBase {
    readonly name = 'Anthropic 兼容';
    readonly driver = 'anthropic-compatible' as const;

    private sdkProvider = createAnthropic({
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
        const parsed = anthropicCompatibleModelsSchema.parse(payload);
        return parsed.data.map((model) => ({
            id: model.id,
            name: model.display_name || model.displayName || model.id,
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
            generationTarget: `${this.normalizedBaseUrl}/messages`,
            discoveryTarget: `${this.normalizedBaseUrl}/models`,
        };
    }
}
