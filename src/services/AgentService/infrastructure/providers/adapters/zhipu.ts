// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { type LanguageModel } from 'ai';
import { createZhipu } from 'zhipu-ai-provider';

import { z } from '@/utils/zod';

import { AiSdkProviderBase } from '../ai-sdk/base';
import type { ProviderApiTargets } from '../types';

const zhipuModelsSchema = z.object({
    data: z.array(
        z.object({
            id: z.string(),
        })
    ),
});

function resolveZhipuSdkBaseUrl(normalizedBaseUrl: string): string {
    if (!normalizedBaseUrl) {
        return '';
    }

    try {
        const { pathname } = new URL(normalizedBaseUrl);
        return pathname && pathname !== '/'
            ? normalizedBaseUrl
            : `${normalizedBaseUrl}/api/paas/v4`;
    } catch {
        return `${normalizedBaseUrl}/api/paas/v4`;
    }
}

/**
 * 智谱适配器。
 */
export class ZhipuProviderAdapter extends AiSdkProviderBase {
    readonly name = 'Zhipu';
    readonly driver = 'zhipu' as const;

    private sdkProvider = createZhipu({
        apiKey: this.apiKey,
        baseURL: this.getApiTargets().sdkBaseUrl || undefined,
        headers: this.getCustomHeaders(),
        fetch: this.fetch,
    });

    protected createLanguageModel(modelId: string) {
        // zhipu SDK 返回的模型实例在运行时与 AI SDK 的 LanguageModel 兼容，
        // 但其 TypeScript 声明并非完全同构，因此这里保留受限的双重断言。
        return this.sdkProvider.chat(modelId) as unknown as LanguageModel;
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
        const parsed = zhipuModelsSchema.parse(payload);
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

        const sdkBaseUrl = resolveZhipuSdkBaseUrl(this.normalizedBaseUrl);
        return {
            normalizedBaseUrl: this.normalizedBaseUrl,
            sdkBaseUrl,
            generationTarget: `${sdkBaseUrl}/chat/completions`,
            discoveryTarget: `${sdkBaseUrl}/models`,
        };
    }
}
