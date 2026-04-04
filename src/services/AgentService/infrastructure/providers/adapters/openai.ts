// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createOpenAI } from '@ai-sdk/openai';

import { z } from '@/utils/zod';

import { AiSdkProviderBase } from '../ai-sdk/base';
import type { ProviderApiTargets } from '../types';

const openAiStyleModelsSchema = z.object({
    data: z.array(
        z.object({
            id: z.string(),
        })
    ),
});

function resolveOpenAiSdkBaseUrl(normalizedBaseUrl: string): string {
    if (!normalizedBaseUrl) {
        return '';
    }

    try {
        const { pathname } = new URL(normalizedBaseUrl);
        // 纯根域名按 OpenAI 官方语义自动补 /v1；
        // 只要用户已经填了路径，就视为精确 compatible baseURL，不能再追加路径。
        return pathname && pathname !== '/' ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    } catch {
        return `${normalizedBaseUrl}/v1`;
    }
}

/**
 * OpenAI 官方适配器。
 */
export class OpenAIProviderAdapter extends AiSdkProviderBase {
    readonly name = 'OpenAI';
    readonly driver = 'openai' as const;

    private sdkProvider = createOpenAI({
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
        const parsed = openAiStyleModelsSchema.parse(payload);
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

        const sdkBaseUrl = resolveOpenAiSdkBaseUrl(this.normalizedBaseUrl);
        return {
            normalizedBaseUrl: this.normalizedBaseUrl,
            sdkBaseUrl,
            generationTarget: `${sdkBaseUrl}/chat/completions`,
            discoveryTarget: `${sdkBaseUrl}/models`,
        };
    }
}
