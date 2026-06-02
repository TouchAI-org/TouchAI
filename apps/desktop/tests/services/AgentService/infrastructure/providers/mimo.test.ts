import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { MiMoProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/mimo';

const fetchMock = vi.hoisted(() => vi.fn());
const chatModelMock = vi.hoisted(() => vi.fn((modelId: string) => ({ modelId })));
const createOpenAiCompatibleMock = vi.hoisted(() =>
    vi.fn(() => ({
        chatModel: chatModelMock,
    }))
);

vi.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: createOpenAiCompatibleMock,
}));

vi.mock('@/services/AgentService/infrastructure/providers/ai-sdk/tauriFetch', () => ({
    createTauriFetch: () => fetchMock,
}));

describe('MiMoProviderAdapter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keeps managed mode pinned to the TouchAI Hub gateway and returns the supported models locally', async () => {
        const provider = new MiMoProviderAdapter({
            apiEndpoint: 'https://hub.touch-ai.org/api/v1',
            apiKey: 'ta_live_managed_key',
            config: {
                touchAiMode: 'managed',
            },
        });

        expect(provider.getApiTargets()).toEqual({
            normalizedBaseUrl: 'https://hub.touch-ai.org/api/v1',
            sdkBaseUrl: 'https://hub.touch-ai.org/api/v1',
            generationTarget: 'https://hub.touch-ai.org/api/v1/chat/completions',
            discoveryTarget: 'https://hub.touch-ai.org/api/v1/models',
        });
        await expect(provider.listModels()).resolves.toEqual([
            { id: 'mimo-v2.5', name: 'mimo-v2.5' },
            { id: 'mimo-v2.5-pro', name: 'mimo-v2.5-pro' },
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uses the provider endpoint directly when builtin MiMo is not switched to explicit custom mode', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ data: [{ id: 'mimo-v2.5' }] }), {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                },
            })
        );

        const provider = new MiMoProviderAdapter({
            apiEndpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
            apiKey: 'tp-provider-key',
            config: null,
        });

        expect(provider.getApiTargets()).toEqual({
            normalizedBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
            sdkBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
            generationTarget: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
            discoveryTarget: 'https://token-plan-cn.xiaomimimo.com/v1/models',
        });
        await expect(provider.listModels()).resolves.toEqual([
            { id: 'mimo-v2.5', name: 'mimo-v2.5' },
        ]);
        expect(fetchMock).toHaveBeenCalledWith(
            'https://token-plan-cn.xiaomimimo.com/v1/models',
            {
                method: 'GET',
                headers: {
                    Authorization: 'Bearer tp-provider-key',
                },
            }
        );
    });

    it('uses the custom endpoint and key stored in config_json when the user switches builtin MiMo to custom mode', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ data: [{ id: 'mimo-v2.5-pro' }] }), {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                },
            })
        );

        const provider = new MiMoProviderAdapter({
            apiEndpoint: 'https://hub.touch-ai.org/api/v1',
            apiKey: 'ta_live_managed_key',
            config: {
                touchAiMode: 'custom',
                touchAiCustom: {
                    apiEndpoint: 'https://openrouter.ai/api/v1',
                    apiKey: 'sk-custom-key',
                },
            },
        });

        expect(provider.getApiTargets()).toEqual({
            normalizedBaseUrl: 'https://openrouter.ai/api/v1',
            sdkBaseUrl: 'https://openrouter.ai/api/v1',
            generationTarget: 'https://openrouter.ai/api/v1/chat/completions',
            discoveryTarget: 'https://openrouter.ai/api/v1/models',
        });
        await expect(provider.listModels()).resolves.toEqual([
            { id: 'mimo-v2.5-pro', name: 'mimo-v2.5-pro' },
        ]);
        expect(fetchMock).toHaveBeenCalledWith(
            'https://openrouter.ai/api/v1/models',
            {
                method: 'GET',
                headers: {
                    Authorization: 'Bearer sk-custom-key',
                },
            }
        );
    });

    it('signs managed gateway requests with the TouchAI desktop auth headers', async () => {
        fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

        const provider = new MiMoProviderAdapter({
            apiEndpoint: 'https://hub.touch-ai.org/api/v1',
            apiKey: 'ta_live_managed_key',
            config: {
                touchAiMode: 'managed',
            },
        });

        await (provider as any).gatewayFetch('https://hub.touch-ai.org/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({ model: 'mimo-v2.5' }),
        });

        const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const headers = new Headers(init.headers);

        expect(target).toBe('https://hub.touch-ai.org/api/v1/chat/completions');
        expect(init.method).toBe('POST');
        expect(init.body).toBe(JSON.stringify({ model: 'mimo-v2.5' }));
        expect(headers.get('Authorization')).toBe('Bearer ta_live_managed_key');
        expect(headers.get('X-TouchAI-Client')).toBe('desktop');
        expect(headers.get('X-TouchAI-Timestamp')).toMatch(/^\d+$/);
        expect(headers.get('X-TouchAI-Nonce')).toMatch(/^touchai-/);
        expect(headers.get('X-TouchAI-Signature')).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('classifies managed gateway auth and rate-limit failures so the desktop client can clear the stored key', () => {
        const provider = new MiMoProviderAdapter({
            apiEndpoint: 'https://hub.touch-ai.org/api/v1',
            apiKey: 'ta_live_managed_key',
            config: {
                touchAiMode: 'managed',
            },
        });

        const authError = provider.classifyError({
            statusCode: 401,
            responseBody: '{"error":{"code":"invalid_signature","message":"invalid signature"}}',
            data: {
                error: {
                    code: 'invalid_signature',
                    message: 'invalid signature',
                },
            },
            message: 'HTTP 401',
        });
        const rateLimitError = provider.classifyError({
            statusCode: 429,
            responseBody: '{"error":{"code":"rate_limited","message":"too many requests"}}',
            data: {
                error: {
                    code: 'rate_limited',
                    message: 'too many requests',
                },
            },
            message: 'HTTP 429',
        });

        expect(authError).toBeInstanceOf(AiError);
        expect(authError?.code).toBe(AiErrorCode.UNAUTHORIZED);
        expect((authError as AiError).details).toMatchObject({
            gatewayCode: 'invalid_signature',
            requiresRelogin: true,
        });

        expect(rateLimitError).toBeInstanceOf(AiError);
        expect(rateLimitError?.code).toBe(AiErrorCode.RATE_LIMIT);
        expect((rateLimitError as AiError).details).toMatchObject({
            gatewayCode: 'rate_limited',
            requiresRelogin: true,
        });
    });

    it('rejects models outside the TouchAI Hub managed allowlist', () => {
        const provider = new MiMoProviderAdapter({
            apiEndpoint: 'https://hub.touch-ai.org/api/v1',
            apiKey: 'ta_live_managed_key',
            config: {
                touchAiMode: 'managed',
            },
        });

        expect(() => (provider as any).createLanguageModel('gpt-4.1')).toThrowError(AiError);
        expect(() => (provider as any).createLanguageModel('gpt-4.1')).toThrow(
            'TouchAI Hub only supports mimo-v2.5 and mimo-v2.5-pro.'
        );
        expect(chatModelMock).not.toHaveBeenCalled();
    });
});
