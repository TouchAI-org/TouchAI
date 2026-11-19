// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createDeepSeek } from '@ai-sdk/deepseek';

import { toModelInfo } from '../catalog/modelList';
import type { ReasoningLevelMap, ReasoningProtocol } from '../contracts/reasoning';
import { z } from '../encoding/json';
import { DEEPSEEK_REASONING_LEVEL_MAP } from '../encoding/reasoning';
import { AiSdkProviderBase } from './base';

const deepseekModelsSchema = z.object({
    data: z.array(
        z
            .object({
                id: z.string(),
            })
            .loose()
    ),
});

/**
 * DeepSeek 适配器。
 */
export class DeepSeekProviderAdapter extends AiSdkProviderBase {
    readonly name = 'DeepSeek';
    readonly driver = 'deepseek' as const;

    private sdkProvider = createDeepSeek({
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
        const parsed = deepseekModelsSchema.parse(payload);
        return parsed.data.map((model) => toModelInfo(model, { id: model.id }));
    }

    protected override getReasoningProtocol(): ReasoningProtocol {
        return 'deepseek';
    }

    protected override getFallbackReasoningLevelMap(modelId: string): ReasoningLevelMap {
        void modelId;
        return DEEPSEEK_REASONING_LEVEL_MAP;
    }
}
