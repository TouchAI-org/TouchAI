// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createMinimax } from 'vercel-minimax-ai-provider';

import { z } from '@/utils/zod';

import { AiSdkProviderBase } from '../ai-sdk/base';
import type { ProviderApiTargets } from '../types';

const minimaxModelsSchema = z.object({
    data: z.array(
        z.object({
            id: z.string(),
            display_name: z.string().optional(),
            displayName: z.string().optional(),
        })
    ),
});

function resolveMiniMaxSdkBaseUrl(normalizedBaseUrl: string): string {
    if (!normalizedBaseUrl) {
        return '';
    }

    try {
        const { pathname } = new URL(normalizedBaseUrl);
        return pathname && pathname !== '/'
            ? normalizedBaseUrl
            : `${normalizedBaseUrl}/anthropic/v1`;
    } catch {
        return `${normalizedBaseUrl}/anthropic/v1`;
    }
}

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
        return parsed.data.map((model) => ({
            id: model.id,
            name: model.display_name || model.displayName || model.id,
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

        const sdkBaseUrl = resolveMiniMaxSdkBaseUrl(this.normalizedBaseUrl);
        return {
            normalizedBaseUrl: this.normalizedBaseUrl,
            sdkBaseUrl,
            generationTarget: `${sdkBaseUrl}/messages`,
            discoveryTarget: `${sdkBaseUrl}/models`,
        };
    }
}
