// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { toModelInfo } from '../catalog/modelList';
import type { ReasoningProtocol } from '../contracts/reasoning';
import { z } from '../encoding/json';
import { AiSdkProviderBase } from './base';

const openAiCompatibleModelsSchema = z.object({
    data: z.array(
        z
            .object({
                id: z.string(),
            })
            .loose()
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
        return parsed.data.map((model) => toModelInfo(model, { id: model.id }));
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
}
