// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createXai } from '@ai-sdk/xai';

import { z } from '@/utils/zod';

import { AiSdkProviderBase } from '../ai-sdk/base';
import type { ProviderApiTargets } from '../types';

const xaiModelsSchema = z.object({
    data: z.array(
        z.object({
            id: z.string(),
        })
    ),
});

function resolveXaiSdkBaseUrl(normalizedBaseUrl: string): string {
    if (!normalizedBaseUrl) {
        return '';
    }

    try {
        const { pathname } = new URL(normalizedBaseUrl);
        // xAI 官方 SDK 默认基于 /v1；当用户已经输入完整路径时，必须原样使用该网关地址。
        return pathname && pathname !== '/' ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    } catch {
        return `${normalizedBaseUrl}/v1`;
    }
}

/**
 * xAI 官方适配器。
 */
export class XaiProviderAdapter extends AiSdkProviderBase {
    readonly name = 'xAI';
    readonly driver = 'xai' as const;

    private sdkProvider = createXai({
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
        const parsed = xaiModelsSchema.parse(payload);
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

        const sdkBaseUrl = resolveXaiSdkBaseUrl(this.normalizedBaseUrl);
        return {
            normalizedBaseUrl: this.normalizedBaseUrl,
            sdkBaseUrl,
            generationTarget: `${sdkBaseUrl}/chat/completions`,
            discoveryTarget: `${sdkBaseUrl}/models`,
        };
    }
}
