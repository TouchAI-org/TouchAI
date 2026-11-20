// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createMinimax } from 'vercel-minimax-ai-provider';

import { toModelInfo } from '../catalog/modelList';
import type { ReasoningProtocol } from '../contracts/reasoning';
import { z } from '../encoding/json';
import { AiSdkProviderBase } from './base';

const minimaxModelsSchema = z.object({
    data: z.array(
        z
            .object({
                id: z.string(),
                display_name: z.string().optional(),
                displayName: z.string().optional(),
            })
            .loose()
    ),
});

/**
 * MiniMax 适配器。
 */
export class MiniMaxProviderAdapter extends AiSdkProviderBase {
    readonly name = 'MiniMax';
    readonly driver = 'minimax' as const;

    private sdkProvider = createMinimax({
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
        const parsed = minimaxModelsSchema.parse(payload);
        return parsed.data.map((model) =>
            toModelInfo(model, { id: model.id, name: model.display_name || model.displayName })
        );
    }

    protected override getReasoningProtocol(): ReasoningProtocol {
        return 'openai';
    }

    protected override getReasoningProviderOptionsKey(): string {
        return 'minimax';
    }
}
