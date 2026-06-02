// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { z } from '@/utils/zod';

import { AiError, AiErrorCode } from '../../../contracts/errors';
import { AiSdkProviderBase, buildUrlWithQueryParams } from '../ai-sdk/base';
import {
    isTouchAiManagedMode,
    TOUCHAI_HUB_GATEWAY_BASE_URL,
    TOUCHAI_HUB_MANAGED_MODEL_SET,
    TOUCHAI_HUB_MANAGED_MODELS,
} from '../config';
import type { ModelInfo, ProviderApiTargets } from '../types';
import { resolveOpenAiStyleSdkBaseUrl } from '../utils';

const reloginRequiredGatewayCodes = new Set([
    'invalid_or_revoked_api_key',
    'invalid_signature',
    'authentication_expired',
    'replay_detected',
]);
const openAiCompatibleModelsSchema = z.object({
    data: z.array(
        z.object({
            id: z.string(),
        })
    ),
});

function extractGatewayError(data: unknown): { code?: string; message?: string } | null {
    if (data == null || typeof data !== 'object') {
        return null;
    }

    const record = data as Record<string, unknown>;
    const error = record.error;
    if (error == null || typeof error !== 'object') {
        return null;
    }

    const errorRecord = error as Record<string, unknown>;
    return {
        code: typeof errorRecord.code === 'string' ? errorRecord.code : undefined,
        message: typeof errorRecord.message === 'string' ? errorRecord.message : undefined,
    };
}

function buildGatewayErrorDetails(
    code: string | undefined,
    statusCode: number | undefined,
    data: unknown
) {
    return {
        gatewayCode: code ?? null,
        statusCode,
        requiresRelogin: code ? reloginRequiredGatewayCodes.has(code) : false,
        payload: data,
    };
}

function normalizeOptionalString(value: string | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
}

export class MiMoProviderAdapter extends AiSdkProviderBase {
    readonly name = 'Xiaomi MiMo';
    readonly driver = 'mimo' as const;

    private readonly explicitCustomMode = this.config.touchAiMode === 'custom';
    private readonly managedMode = isTouchAiManagedMode(this.config, this.normalizedBaseUrl);
    private readonly customApiEndpoint = this.explicitCustomMode
        ? normalizeOptionalString(this.config.touchAiCustom?.apiEndpoint)
        : this.normalizedBaseUrl;
    private readonly customApiKey = this.explicitCustomMode
        ? normalizeOptionalString(this.config.touchAiCustom?.apiKey) || undefined
        : this.apiKey;
    private readonly gatewayFetch = this.createGatewayFetch();
    private readonly sdkProvider = createOpenAICompatible({
        name: 'mimo',
        apiKey: this.getResolvedApiKey(),
        baseURL: this.getApiTargets().sdkBaseUrl || '',
        headers: this.getSdkHeaders(),
        fetch: this.managedMode ? this.gatewayFetch : this.fetch,
        includeUsage: false,
    });

    protected createLanguageModel(modelId: string) {
        if (this.managedMode) {
            this.assertSupportedModelId(modelId);
        }

        return this.sdkProvider.chatModel(modelId);
    }

    protected getDiscoveryHeaders(): Record<string, string> {
        if (this.managedMode) {
            return {
                ...(this.apiKey
                    ? {
                          Authorization: `Bearer ${this.apiKey}`,
                      }
                    : {}),
                ...this.getGatewayHeaders(),
            };
        }

        return {
            ...(this.customApiKey
                ? {
                      Authorization: `Bearer ${this.customApiKey}`,
                  }
                : {}),
            ...this.getCustomHeaders(),
        };
    }

    protected parseModelList(payload: unknown) {
        if (this.managedMode) {
            void payload;
            return this.getSupportedModels();
        }

        const parsed = openAiCompatibleModelsSchema.parse(payload);
        return parsed.data.map((model) => ({
            id: model.id,
            name: model.id,
        }));
    }

    async listModels(): Promise<ModelInfo[]> {
        if (this.managedMode) {
            return this.getSupportedModels();
        }

        return await super.listModels();
    }

    protected classifyApiCallError(statusCode: number | undefined, data: unknown): AiError | null {
        if (!this.managedMode) {
            return null;
        }

        const gatewayError = extractGatewayError(data);
        const details = buildGatewayErrorDetails(gatewayError?.code, statusCode, data);
        const message = gatewayError?.message;

        switch (gatewayError?.code) {
            case 'auth_required':
            case 'invalid_or_revoked_api_key':
            case 'invalid_signature':
            case 'authentication_expired':
            case 'replay_detected':
                return new AiError(AiErrorCode.UNAUTHORIZED, details, message);
            case 'rate_limited':
            case 'upstream_rate_limited':
                return new AiError(AiErrorCode.RATE_LIMIT, details, message);
            case 'upstream_unavailable':
                return new AiError(AiErrorCode.SERVICE_UNAVAILABLE, details, message);
            case 'upstream_unauthorized':
                return new AiError(AiErrorCode.BAD_GATEWAY, details, message);
            case 'activity_not_eligible':
            case 'quota_paused':
            case 'policy_blocked':
                return new AiError(AiErrorCode.API_ERROR, details, message);
            default:
                if (statusCode === 401 || statusCode === 403) {
                    return new AiError(AiErrorCode.UNAUTHORIZED, details, message);
                }
                return null;
        }
    }

    getApiTargets(): ProviderApiTargets {
        if (!this.managedMode) {
            if (!this.customApiEndpoint) {
                return {
                    normalizedBaseUrl: '',
                    sdkBaseUrl: '',
                    generationTarget: '',
                    discoveryTarget: '',
                };
            }

            const sdkBaseUrl = resolveOpenAiStyleSdkBaseUrl(this.customApiEndpoint);
            return {
                normalizedBaseUrl: this.customApiEndpoint,
                sdkBaseUrl,
                generationTarget: `${sdkBaseUrl}/chat/completions`,
                discoveryTarget: `${sdkBaseUrl}/models`,
            };
        }

        const sdkBaseUrl = resolveOpenAiStyleSdkBaseUrl(TOUCHAI_HUB_GATEWAY_BASE_URL);
        return {
            normalizedBaseUrl: TOUCHAI_HUB_GATEWAY_BASE_URL,
            sdkBaseUrl,
            generationTarget: `${sdkBaseUrl}/chat/completions`,
            discoveryTarget: `${sdkBaseUrl}/models`,
        };
    }

    private getResolvedApiKey(): string | undefined {
        return this.managedMode ? this.apiKey : this.customApiKey;
    }

    private getSdkHeaders(): Record<string, string> {
        return this.managedMode ? this.getGatewayHeaders() : this.getCustomHeaders();
    }

    private getGatewayHeaders(): Record<string, string> {
        return {
            'X-TouchAI-Client': 'desktop',
            ...this.getCustomHeaders(),
        };
    }

    private getSupportedModels(): ModelInfo[] {
        return TOUCHAI_HUB_MANAGED_MODELS.map((modelId) => ({
            id: modelId,
            name: modelId,
        }));
    }

    private assertSupportedModelId(modelId: string): void {
        if (TOUCHAI_HUB_MANAGED_MODEL_SET.has(modelId)) {
            return;
        }

        throw new AiError(
            AiErrorCode.MODEL_NOT_FOUND,
            {
                modelId,
                supportedModels: [...TOUCHAI_HUB_MANAGED_MODELS],
            },
            'TouchAI Hub only supports mimo-v2.5 and mimo-v2.5-pro.'
        );
    }

    private createGatewayFetch(): typeof fetch {
        return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const request = this.normalizeRequest(input, init);
            const signedRequest = await this.signGatewayRequest(this.withFinalGatewayUrl(request));
            return this.fetch(signedRequest.url, {
                method: signedRequest.method,
                headers: signedRequest.headers,
                body:
                    signedRequest.method === 'GET' || signedRequest.method === 'HEAD'
                        ? undefined
                        : await signedRequest.clone().text(),
            });
        };
    }

    private normalizeRequest(input: RequestInfo | URL, init?: RequestInit): Request {
        if (input instanceof Request && !init) {
            return input;
        }

        const url =
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

        return new Request(url, init);
    }

    private withFinalGatewayUrl(request: Request): Request {
        const queryParams = this.config.queryParams ?? {};
        const finalUrl = buildUrlWithQueryParams(request.url, queryParams);
        if (finalUrl === request.url) {
            return request;
        }

        return new Request(finalUrl, {
            method: request.method,
            headers: request.headers,
            body:
                request.method === 'GET' || request.method === 'HEAD'
                    ? undefined
                    : request.clone().body,
            duplex: 'half',
        } as RequestInit);
    }

    private async signGatewayRequest(request: Request): Promise<Request> {
        if (!this.apiKey) {
            return request;
        }

        const bodyText =
            request.method === 'GET' || request.method === 'HEAD'
                ? ''
                : await request.clone().text();
        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = `touchai-${crypto.randomUUID()}`;
        const bodyHash = await sha256Hex(bodyText);
        const requestUrl = new URL(request.url);
        const signature = await hmacBase64Url(
            [
                request.method.toUpperCase(),
                `${requestUrl.pathname}${requestUrl.search}`,
                timestamp,
                nonce,
                bodyHash,
            ].join('\n'),
            this.apiKey
        );

        const headers = new Headers(request.headers);
        headers.set('Authorization', `Bearer ${this.apiKey}`);
        headers.set('X-TouchAI-Client', 'desktop');
        headers.set('X-TouchAI-Timestamp', timestamp);
        headers.set('X-TouchAI-Nonce', nonce);
        headers.set('X-TouchAI-Signature', signature);

        return new Request(request.url, {
            method: request.method,
            headers,
            body: request.method === 'GET' || request.method === 'HEAD' ? undefined : bodyText,
        });
    }
}

async function sha256Hex(value: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacBase64Url(value: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
    let binary = '';
    new Uint8Array(signature).forEach((byte) => {
        binary += String.fromCharCode(byte);
    });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
