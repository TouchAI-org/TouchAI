// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createMoonshotAI } from '@ai-sdk/moonshotai';

import { toModelInfo } from '../catalog/modelList';
import type { ReasoningProtocol } from '../contracts/reasoning';
import { z } from '../encoding/json';
import { AiSdkProviderBase } from './base';

const moonshotModelsSchema = z.object({
    data: z.array(
        z
            .object({
                id: z.string(),
            })
            .loose()
    ),
});

/**
 * Moonshot 适配器。
 */
export class MoonshotProviderAdapter extends AiSdkProviderBase {
    readonly name = 'Moonshot';
    readonly driver = 'moonshot' as const;

    private sdkProvider = createMoonshotAI({
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
        const parsed = moonshotModelsSchema.parse(payload);
        return parsed.data.map((model) => toModelInfo(model, { id: model.id }));
    }

    protected override getReasoningProtocol(): ReasoningProtocol {
        return 'deepseek';
    }

    protected override getReasoningProviderOptionsKey(): string {
        return 'moonshotai';
    }
}
