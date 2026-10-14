// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createOpenAI } from '@ai-sdk/openai';

import { z } from '@/utils/zod';

import type { ReasoningOption, ReasoningProtocol } from '../../../contracts/reasoning';
import { normalizeReasoningOptions } from '../../../contracts/reasoning';
import { AiSdkProviderBase } from '../ai-sdk/base';
import type { ReasoningNative } from '../reasoning';
import { getOpenAiReasoningCapability, isOpenAiGpt6SolOrLuna } from '../reasoning';
import type { ProviderApiTargets } from '../types';
import { resolveOpenAiStyleSdkBaseUrl } from '../utils';

const openAiStyleModelsSchema = z.object({
    data: z.array(
        z.object({
            id: z.string(),
            reasoning_options: z.unknown().optional(),
        })
    ),
});

/**
 * OpenAI 官方适配器。
 *
 * 默认走 Responses API（无状态 + 回传加密 reasoning），设置
 * `reasoning.protocol = 'openai-chat'` 可退回 Chat Completions。
 */
export class OpenAIProviderAdapter extends AiSdkProviderBase {
    readonly name = 'OpenAI';
    readonly driver = 'openai' as const;

    private sdkProvider = createOpenAI({
        apiKey: this.apiKey || '',
        baseURL: this.getApiTargets().sdkBaseUrl || undefined,
        headers: this.getCustomHeaders(),
        fetch: this.fetch,
    });

    protected createLanguageModel(modelId: string) {
        if (this.getEffectiveProtocol() === 'openai-responses') {
            return this.sdkProvider.responses(modelId);
        }
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
        return 'openai-responses';
    }

    protected override getFallbackReasoningCapability(modelId: string): ReasoningOption[] {
        return getOpenAiReasoningCapability(modelId);
    }

    /**
     * GPT-6 Sol/Luna 在 Chat Completions 下只有 `none` 支持 function calling；
     * Responses API 没有该限制。
     */
    protected override applyReasoningConstraint(
        native: ReasoningNative,
        context: { modelId: string; hasTools: boolean }
    ): ReasoningNative {
        if (
            this.getEffectiveProtocol() === 'openai-chat' &&
            context.hasTools &&
            isOpenAiGpt6SolOrLuna(context.modelId)
        ) {
            return { kind: 'effort', effort: 'none' };
        }
        return native;
    }

    private getEffectiveProtocol(): ReasoningProtocol {
        return this.config.reasoning?.protocol ?? this.getReasoningProtocol() ?? 'openai-responses';
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
        const generationPath =
            this.getEffectiveProtocol() === 'openai-responses' ? '/responses' : '/chat/completions';
        return {
            normalizedBaseUrl: this.normalizedBaseUrl,
            sdkBaseUrl,
            generationTarget: `${sdkBaseUrl}${generationPath}`,
            discoveryTarget: `${sdkBaseUrl}/models`,
        };
    }
}
