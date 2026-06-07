import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError, AiErrorCode } from '@/contracts/agentErrors';
import { MiMoProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/mimo';

const fetchMock = vi.hoisted(() => vi.fn());
const chatModelMock = vi.hoisted(() => vi.fn((modelId: string) => ({ modelId })));
const createOpenAiCompatibleMock = vi.hoisted(() =>
    vi.fn(() => ({
        chatModel: chatModelMock,
    }))
);

type TestableMiMoProviderAdapter = {
    gatewayFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    createLanguageModel: (modelId: string) => unknown;
};

const asTestableProvider = (provider: MiMoProviderAdapter): TestableMiMoProviderAdapter =>
    provider as unknown as TestableMiMoProviderAdapter;

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

    it('keeps managed mode pinned to the TouchAI Hub gateway and discovers models from the hub', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: [{ id: 'mimo-latest' }, { id: 'mimo-pro-latest' }],
                }),
                {
                    status: 200,
                    headers: {
                        'content-type': 'application/json',
                    },
                }
            )
        );

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
            { id: 'mimo-latest', name: 'mimo-latest' },
            { id: 'mimo-pro-latest', name: 'mimo-pro-latest' },
        ]);
        const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const headers = new Headers(init.headers);

        expect(target).toBe('https://hub.touch-ai.org/api/v1/models');
        expect(init.method).toBe('GET');
        expect(init.body).toBeUndefined();
        expect(headers.get('Authorization')).toBe('Bearer ta_live_managed_key');
        expect(headers.get('X-TouchAI-Client')).toBe('desktop');
        expect(headers.get('X-TouchAI-Timestamp')).toMatch(/^\d+$/);
        expect(headers.get('X-TouchAI-Nonce')).toMatch(/^touchai-/);
        expect(headers.get('X-TouchAI-Signature')).toMatch(/^[A-Za-z0-9_-]+$/);
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
        expect(fetchMock).toHaveBeenCalledWith('https://token-plan-cn.xiaomimimo.com/v1/models', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer tp-provider-key',
            },
        });
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
        expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer sk-custom-key',
            },
        });
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

        await asTestableProvider(provider).gatewayFetch(
            'https://hub.touch-ai.org/api/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ model: 'mimo-v2.5' }),
            }
        );

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
            requiresRelogin: false,
        });
    });

    it('keeps provider business messages raw for managed gateway policy errors', () => {
        const provider = new MiMoProviderAdapter({
            apiEndpoint: 'https://hub.touch-ai.org/api/v1',
            apiKey: 'ta_live_managed_key',
            config: {
                touchAiMode: 'managed',
            },
        });

        const policyError = provider.classifyError({
            statusCode: 403,
            responseBody:
                '{"error":{"code":"policy_blocked","message":"This activity is not eligible for your account."}}',
            data: {
                error: {
                    code: 'policy_blocked',
                    message: 'This activity is not eligible for your account.',
                },
            },
            message: 'HTTP 403',
        });

        expect(policyError).toBeInstanceOf(AiError);
        expect(policyError?.code).toBe(AiErrorCode.API_ERROR);
        expect(policyError?.message).toBe('This activity is not eligible for your account.');
        expect(policyError?.getDisplayMessage()).toBe(
            'This activity is not eligible for your account.'
        );
    });

    it('treats unstructured managed gateway unauthorized responses as requiring relogin', () => {
        const provider = new MiMoProviderAdapter({
            apiEndpoint: 'https://hub.touch-ai.org/api/v1',
            apiKey: 'ta_live_managed_key',
            config: {
                touchAiMode: 'managed',
            },
        });

        const authError = provider.classifyError({
            statusCode: 401,
            responseBody: '{"message":"Unauthorized"}',
            message: 'Unauthorized',
        });

        expect(authError).toBeInstanceOf(AiError);
        expect(authError?.code).toBe(AiErrorCode.UNAUTHORIZED);
        expect((authError as AiError).details).toMatchObject({
            gatewayCode: null,
            statusCode: 401,
            requiresRelogin: true,
        });
    });

    it('lets the hub validate managed model ids at request time', () => {
        const provider = new MiMoProviderAdapter({
            apiEndpoint: 'https://hub.touch-ai.org/api/v1',
            apiKey: 'ta_live_managed_key',
            config: {
                touchAiMode: 'managed',
            },
        });

        expect(asTestableProvider(provider).createLanguageModel('mimo-latest')).toEqual({
            modelId: 'mimo-latest',
        });
        expect(chatModelMock).toHaveBeenCalledWith('mimo-latest');
    });
});
