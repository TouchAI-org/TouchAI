// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createAnthropic } from '@ai-sdk/anthropic';

import { toModelInfo } from '../catalog/modelList';
import { AiError, AiErrorCode } from '../contracts/errors';
import type { ReasoningProtocol } from '../contracts/reasoning';
import { z } from '../encoding/json';
import { AiSdkProviderBase } from './base';

const anthropicStyleModelsSchema = z.object({
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

const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * Anthropic 官方适配器。
 */
export class AnthropicProviderAdapter extends AiSdkProviderBase {
    readonly name = 'Anthropic';
    readonly driver = 'anthropic' as const;

    private sdkProvider = createAnthropic({
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
                      'x-api-key': this.apiKey,
                  }
                : {}),
            'anthropic-version': ANTHROPIC_API_VERSION,
            ...this.getCustomHeaders(),
        };
    }

    protected parseModelList(payload: unknown) {
        const parsed = anthropicStyleModelsSchema.parse(payload);
        return parsed.data.map((model) =>
            toModelInfo(model, { id: model.id, name: model.display_name || model.displayName })
        );
    }

    protected classifyApiCallError(_statusCode: number | undefined, data: unknown): AiError | null {
        if (data == null || typeof data !== 'object') return null;
        const record = data as Record<string, unknown>;
        // Anthropic 格式: { type: "error", error: { type, message } }
        const error =
            record.error != null && typeof record.error === 'object'
                ? (record.error as Record<string, unknown>)
                : null;
        if (!error) return null;

        const errorType = typeof error.type === 'string' ? error.type : undefined;
        const message = typeof error.message === 'string' ? error.message : undefined;
        if (errorType === 'overloaded_error') {
            return new AiError(AiErrorCode.SERVICE_UNAVAILABLE, undefined, message);
        }
        if (errorType === 'rate_limit_error') {
            return new AiError(AiErrorCode.RATE_LIMIT, undefined, message);
        }
        if (errorType === 'authentication_error') {
            return new AiError(AiErrorCode.INVALID_API_KEY, undefined, message);
        }
        return null;
    }

    protected override getReasoningProtocol(): ReasoningProtocol {
        return 'anthropic-messages';
    }
}
