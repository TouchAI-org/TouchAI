// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createAnthropic } from '@ai-sdk/anthropic';

import { z } from '@/utils/zod';

import { AiError, AiErrorCode } from '../../../contracts/errors';
import { AiSdkProviderBase } from '../ai-sdk/base';
import type { ProviderApiTargets } from '../types';

const anthropicStyleModelsSchema = z.object({
    data: z.array(
        z.object({
            id: z.string(),
            display_name: z.string().optional(),
            displayName: z.string().optional(),
        })
    ),
});

const ANTHROPIC_API_VERSION = '2023-06-01';

function resolveAnthropicSdkBaseUrl(normalizedBaseUrl: string): string {
    if (!normalizedBaseUrl) {
        return '';
    }

    try {
        const { pathname } = new URL(normalizedBaseUrl);
        // 纯根域名按官方地址补 /v1；
        // 带路径的地址通常已经是兼容网关给出的精确 baseURL，必须原样使用。
        return pathname && pathname !== '/' ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    } catch {
        return `${normalizedBaseUrl}/v1`;
    }
}

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
        return parsed.data.map((model) => ({
            id: model.id,
            name: model.display_name || model.displayName || model.id,
        }));
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

    getApiTargets(): ProviderApiTargets {
        if (!this.normalizedBaseUrl) {
            return {
                normalizedBaseUrl: '',
                sdkBaseUrl: '',
                generationTarget: '',
                discoveryTarget: '',
            };
        }

        const sdkBaseUrl = resolveAnthropicSdkBaseUrl(this.normalizedBaseUrl);
        return {
            normalizedBaseUrl: this.normalizedBaseUrl,
            sdkBaseUrl,
            generationTarget: `${sdkBaseUrl}/messages`,
            discoveryTarget: `${sdkBaseUrl}/models`,
        };
    }
}
