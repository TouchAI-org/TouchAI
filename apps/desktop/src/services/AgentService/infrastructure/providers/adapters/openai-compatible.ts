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

/**
 * OpenAI-compatible 适配器。
 *
 * 使用 @ai-sdk/openai-compatible SDK，默认不发送 stream_options，
 * 兼容不支持该参数的第三方 provider（如 MiMo）。
 *
 * 中转站的 reasoning 语义不可信：默认 auto 不发参数；确认支持思考时在
 * provider config 里设置 `reasoning.mode = 'passthrough'`（或指定 protocol）。
 */
export class OpenAICompatibleProviderAdapter extends AiSdkProviderBase {
    readonly name = 'OpenAI 兼容';
    readonly driver = 'openai-compatible' as const;

    private sdkProvider = createOpenAICompatible({
        name: 'openai-compatible',
        apiKey: this.apiKey || '',
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

    protected override getReasoningProtocol(): ReasoningProtocol {
        return 'openai-compatible';
    }

    protected override getReasoningProviderOptionsKey(): string {
        return 'openaiCompatible';
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
