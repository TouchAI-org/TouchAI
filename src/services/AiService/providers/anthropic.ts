// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { createAnthropic } from '@ai-sdk/anthropic';
import type { ProviderApiTargets } from '@services/AiService/types';

import { z } from '@/utils/zod';

import { AiSdkProviderBase } from './shared/ai-sdk-base';

const anthropicStyleModelsSchema = z.object({
    data: z.array(
        z.object({
            id: z.string(),
            display_name: z.string().optional(),
            displayName: z.string().optional(),
        })
    ),
});

function resolveAnthropicSdkBaseUrl(normalizedBaseUrl: string): string {
    if (!normalizedBaseUrl) {
        return '';
    }

    try {
        const { pathname } = new URL(normalizedBaseUrl);
        // 纯根域名按官方地址补 /v1；
        // 带路径的地址通常已经是兼容网关给出的精确 baseURL，必须原样使用。
        return pathname && pathname !== '/' ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    } catch {
        return `${normalizedBaseUrl}/v1`;
    }
}

/**
 * Anthropic 官方适配器。
 */
export class AnthropicProviderAdapter extends AiSdkProviderBase {
    readonly name = 'Anthropic';
    readonly driver = 'anthropic' as const;

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
                      'x-api-key': this.apiKey,
                  }
                : {}),
            'anthropic-version': '2023-06-01',
            ...this.getCustomHeaders(),
        };
    }

    protected parseModelList(payload: unknown) {
        const parsed = anthropicStyleModelsSchema.parse(payload);
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

        const sdkBaseUrl = resolveAnthropicSdkBaseUrl(this.normalizedBaseUrl);
        return {
            normalizedBaseUrl: this.normalizedBaseUrl,
            sdkBaseUrl,
            generationTarget: `${sdkBaseUrl}/messages`,
            discoveryTarget: `${sdkBaseUrl}/models`,
        };
    }
}
