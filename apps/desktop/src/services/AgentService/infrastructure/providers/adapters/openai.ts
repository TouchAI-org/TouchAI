// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createOpenAI, type OpenAIChatLanguageModelOptions } from '@ai-sdk/openai';

import { z } from '@/utils/zod';

import {
    deriveReasoningLevelMap,
    type ReasoningLevelMap,
    type ReasoningProtocol,
    type SelectableReasoningLevel,
} from '../../../contracts/reasoning';
import { AiSdkProviderBase } from '../ai-sdk/base';
import { toModelInfo } from '../modelList';
import { getOpenAiReasoningLevelMap, isOpenAiGpt6SolOrLuna } from '../reasoning';
import type { ProviderApiTargets, ProviderReasoningInput } from '../types';
import { resolveOpenAiStyleSdkBaseUrl } from '../utils';

const openAiStyleModelsSchema = z.object({
    data: z.array(
        z
            .object({
                id: z.string(),
            })
            .loose()
    ),
});

// Chat has a closed SDK enum; Responses and compatible transports accept arbitrary efforts.
const chatReasoningEfforts = new Set<string>([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] satisfies NonNullable<OpenAIChatLanguageModelOptions['reasoningEffort']>[]);

/**
 * OpenAI 官方适配器。
 *
 * 默认走 Responses API（无状态 + 回传加密 reasoning），设置
 * `reasoning.format = 'openai'` 可退回 Chat Completions。
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
        if (this.getEffectiveFormat() === 'openai-responses') {
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
        return parsed.data.map((model) => toModelInfo(model, { id: model.id }));
    }

    protected override getReasoningProtocol(): ReasoningProtocol {
        return 'openai-responses';
    }

    protected override getFallbackReasoningLevelMap(modelId: string): ReasoningLevelMap {
        return getOpenAiReasoningLevelMap(modelId);
    }

    protected override filterReasoningLevels(
        levels: SelectableReasoningLevel[],
        options: ProviderReasoningInput
    ): SelectableReasoningLevel[] {
        const format = this.getEffectiveFormat();
        if (format !== 'openai' && format !== 'openai-responses') return levels;

        const map = options.reasoningOptions?.length
            ? deriveReasoningLevelMap(options.reasoningOptions)
            : this.getFallbackReasoningLevelMap(options.model);
        const sdkEfforts = getOpenAiSdkReasoningEfforts(options.model);
        return levels.filter((level) => {
            const effort =
                level === 'off'
                    ? format === 'openai'
                        ? map.off
                        : (map.off ?? 'none')
                    : (map[level] ?? level);
            if (sdkEfforts && typeof effort === 'string' && !sdkEfforts.has(effort)) {
                return false;
            }
            return (
                format !== 'openai' ||
                (typeof effort === 'string' && chatReasoningEfforts.has(effort))
            );
        });
    }

    /**
     * GPT-6 Sol/Luna 在 Chat Completions 下只有 `none` 支持 function calling；
     * Responses API 没有该限制。
     */
    protected override applyReasoningConstraint(
        level: SelectableReasoningLevel,
        context: { modelId: string; hasTools: boolean }
    ): SelectableReasoningLevel {
        if (
            this.getEffectiveFormat() === 'openai' &&
            context.hasTools &&
            isOpenAiGpt6SolOrLuna(context.modelId)
        ) {
            return 'off';
        }
        return level;
    }

    private getEffectiveFormat(): ReasoningProtocol {
        return this.getEffectiveReasoningFormat() ?? 'openai-responses';
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
            this.getEffectiveFormat() === 'openai-responses' ? '/responses' : '/chat/completions';
        return {
            normalizedBaseUrl: this.normalizedBaseUrl,
            sdkBaseUrl,
            generationTarget: `${sdkBaseUrl}${generationPath}`,
            discoveryTarget: `${sdkBaseUrl}/models`,
        };
    }
}

/**
 * The official OpenAI SDK restricts efforts by exact, recognizable model ID.
 * Keep unsupported metadata entries out of the picker before the SDK drops them.
 */
function getOpenAiSdkReasoningEfforts(modelId: string): ReadonlySet<string> | undefined {
    const gptVersion = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(modelId);

    if (!gptVersion) return undefined;

    const major = Number(gptVersion[1]);
    if (major < 6) return undefined;

    if (modelId === 'gpt-6-sol' || modelId === 'gpt-6-luna') {
        return new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    }
    return new Set(['low', 'medium', 'high', 'xhigh', 'max']);
}
