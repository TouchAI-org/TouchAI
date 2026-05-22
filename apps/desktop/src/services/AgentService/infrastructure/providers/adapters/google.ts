// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createGoogleGenerativeAI } from '@ai-sdk/google';

import { z } from '@/utils/zod';

import { AiError, AiErrorCode } from '../../../contracts/errors';
import { AiSdkProviderBase } from '../ai-sdk/base';
import type { ProviderApiTargets } from '../types';

const googleModelsSchema = z.object({
    models: z.array(
        z.object({
            name: z.string(),
            displayName: z.string().nullable().optional(),
            supportedGenerationMethods: z.array(z.string()).nullable().optional(),
        })
    ),
});

const GOOGLE_API_VERSION_PATH = 'v1beta';

/**
 * Gemini 官方适配器。
 */
export class GoogleProviderAdapter extends AiSdkProviderBase {
    readonly name = 'Google';
    readonly driver = 'google' as const;

    private sdkProvider = createGoogleGenerativeAI({
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
                      'x-goog-api-key': this.apiKey,
                  }
                : {}),
            ...this.getCustomHeaders(),
        };
    }

    protected parseModelList(payload: unknown) {
        const parsed = googleModelsSchema.parse(payload);

        return parsed.models
            .filter((model) => {
                const methods = model.supportedGenerationMethods ?? [];
                return (
                    methods.length === 0 ||
                    methods.some((method) =>
                        ['generatecontent', 'streamgeneratecontent'].includes(method.toLowerCase())
                    )
                );
            })
            .map((model) => {
                const normalizedId = model.name.replace(/^models\//, '');
                return {
                    id: normalizedId,
                    name: model.displayName || normalizedId,
                };
            });
    }

    protected classifyApiCallError(_statusCode: number | undefined, data: unknown): AiError | null {
        if (data == null || typeof data !== 'object') return null;
        const record = data as Record<string, unknown>;
        const error =
            record.error != null && typeof record.error === 'object'
                ? (record.error as Record<string, unknown>)
                : null;
        if (!error) return null;

        // Google 原生格式: { error: { code, message, status } }
        const status = typeof error.status === 'string' ? error.status : undefined;
        const message = typeof error.message === 'string' ? error.message : undefined;
        if (status === 'RESOURCE_EXHAUSTED') {
            return new AiError(AiErrorCode.RATE_LIMIT, undefined, message);
        }
        if (status === 'PERMISSION_DENIED') {
            return new AiError(AiErrorCode.UNAUTHORIZED, undefined, message);
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

        const sdkBaseUrl = `${this.normalizedBaseUrl}/${GOOGLE_API_VERSION_PATH}`;
        return {
            normalizedBaseUrl: this.normalizedBaseUrl,
            sdkBaseUrl,
            generationTarget: `${sdkBaseUrl}/models/{model}:streamGenerateContent`,
            discoveryTarget: `${sdkBaseUrl}/models`,
        };
    }
}
