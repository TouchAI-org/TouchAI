// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createXai } from '@ai-sdk/xai';

import { toModelInfo } from '../catalog/modelList';
import type { ReasoningProtocol } from '../contracts/reasoning';
import { z } from '../encoding/json';
import { AiSdkProviderBase } from './base';

const xaiModelsSchema = z.object({
    data: z.array(
        z
            .object({
                id: z.string(),
            })
            .loose()
    ),
});

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
        return parsed.data.map((model) => toModelInfo(model, { id: model.id }));
    }

    protected override getReasoningProtocol(): ReasoningProtocol {
        return 'openai';
    }

    protected override getReasoningProviderOptionsKey(): string {
        return 'xai';
    }
}
