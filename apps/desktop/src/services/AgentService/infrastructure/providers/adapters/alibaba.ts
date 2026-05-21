// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createAlibaba } from '@ai-sdk/alibaba';

import { z } from '@/utils/zod';

import { AiSdkProviderBase } from '../ai-sdk/base';
import type { ProviderApiTargets } from '../types';

const alibabaModelsSchema = z.object({
    data: z.array(
        z.object({
            id: z.string(),
        })
    ),
});

function resolveAlibabaSdkBaseUrl(normalizedBaseUrl: string): string {
    if (!normalizedBaseUrl) {
        return '';
    }

    try {
        const { pathname } = new URL(normalizedBaseUrl);
        return pathname && pathname !== '/'
            ? normalizedBaseUrl
            : `${normalizedBaseUrl}/compatible-mode/v1`;
    } catch {
        return `${normalizedBaseUrl}/compatible-mode/v1`;
    }
}

/**
 * Alibaba 适配器。
 */
export class AlibabaProviderAdapter extends AiSdkProviderBase {
    readonly name = 'Alibaba';
    readonly driver = 'alibaba' as const;

    private sdkProvider = createAlibaba({
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
        const parsed = alibabaModelsSchema.parse(payload);
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

        const sdkBaseUrl = resolveAlibabaSdkBaseUrl(this.normalizedBaseUrl);
        return {
            normalizedBaseUrl: this.normalizedBaseUrl,
            sdkBaseUrl,
            generationTarget: `${sdkBaseUrl}/chat/completions`,
            discoveryTarget: `${sdkBaseUrl}/models`,
        };
    }
}
