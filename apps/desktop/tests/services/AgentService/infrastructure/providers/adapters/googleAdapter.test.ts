import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiErrorCode } from '@/services/AgentService/contracts/errors';
import { GoogleProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/google';

/**
 * Gemini is reached through a different address shape and a different error vocabulary than the
 * other providers: the SDK path carries the API version, discovery returns `models/...` names,
 * and failures are named by a `status` string.
 *
 * Only the network boundary is mocked; URL building, model filtering and error classification
 * run for real.
 */

const { tauriFetchMock } = vi.hoisted(() => ({ tauriFetchMock: vi.fn() }));

vi.mock('@/services/AgentService/infrastructure/providers/ai-sdk/tauriFetch', () => ({
    createTauriFetch: () => tauriFetchMock,
}));

function adapter(config: { apiEndpoint: string; apiKey?: string; config?: unknown }) {
    return new GoogleProviderAdapter(config as never);
}

function modelsResponse(models: unknown[]): Response {
    return new Response(JSON.stringify({ models }), { status: 200 });
}

describe('user connects to a Google Gemini endpoint', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('user gets the API version added to the address the SDK needs', () => {
        const targets = adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
        }).getApiTargets();

        expect(targets.sdkBaseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
        expect(targets.discoveryTarget).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models'
        );
    });

    it('user gets the generation address templated on the model', () => {
        const targets = adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
        }).getApiTargets();

        expect(targets.generationTarget).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent'
        );
    });

    it('user gets a gateway address with its own path kept before the version', () => {
        const targets = adapter({
            apiEndpoint: 'https://gateway.example.com/gemini',
        }).getApiTargets();

        expect(targets.sdkBaseUrl).toBe('https://gateway.example.com/gemini/v1beta');
    });

    it('user gets the trailing slash removed before the version is appended', () => {
        const targets = adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com//',
        }).getApiTargets();

        expect(targets.normalizedBaseUrl).toBe('https://generativelanguage.googleapis.com');
        expect(targets.sdkBaseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
    });

    it('user gets no request target at all when the endpoint is empty', () => {
        expect(adapter({ apiEndpoint: '' }).getApiTargets()).toEqual({
            normalizedBaseUrl: '',
            sdkBaseUrl: '',
            generationTarget: '',
            discoveryTarget: '',
        });
    });
});

describe('user lists the models a Gemini endpoint offers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('user gets the model id without the models prefix so it can be called', async () => {
        tauriFetchMock.mockResolvedValue(
            modelsResponse([{ name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' }])
        );

        await expect(
            adapter({ apiEndpoint: 'https://generativelanguage.googleapis.com' }).listModels()
        ).resolves.toEqual([{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }]);
    });

    it('user gets the model id used as its name when Gemini sent no display name', async () => {
        tauriFetchMock.mockResolvedValue(modelsResponse([{ name: 'models/gemini-pro' }]));

        await expect(
            adapter({ apiEndpoint: 'https://generativelanguage.googleapis.com' }).listModels()
        ).resolves.toEqual([{ id: 'gemini-pro', name: 'gemini-pro' }]);
    });

    it('user gets a null display name treated as no display name', async () => {
        tauriFetchMock.mockResolvedValue(
            modelsResponse([{ name: 'models/gemini-pro', displayName: null }])
        );

        await expect(
            adapter({ apiEndpoint: 'https://generativelanguage.googleapis.com' }).listModels()
        ).resolves.toEqual([{ id: 'gemini-pro', name: 'gemini-pro' }]);
    });

    it('user does not get embedding-only models in the chat model picker', async () => {
        tauriFetchMock.mockResolvedValue(
            modelsResponse([
                { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
                {
                    name: 'models/gemini-2.0-flash',
                    supportedGenerationMethods: ['generateContent'],
                },
            ])
        );

        const models = await adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
        }).listModels();

        expect(models.map((model) => model.id)).toEqual(['gemini-2.0-flash']);
    });

    it('user gets a streaming-capable model kept in the picker', async () => {
        tauriFetchMock.mockResolvedValue(
            modelsResponse([
                {
                    name: 'models/gemini-2.5-pro',
                    supportedGenerationMethods: ['streamGenerateContent'],
                },
            ])
        );

        const models = await adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
        }).listModels();

        expect(models.map((model) => model.id)).toEqual(['gemini-2.5-pro']);
    });

    it('user gets a model kept when the endpoint listed no capabilities at all', async () => {
        // An older or proxied endpoint may omit the method list; hiding every model would leave
        // the user with an empty picker.
        tauriFetchMock.mockResolvedValue(modelsResponse([{ name: 'models/gemini-legacy' }]));

        await expect(
            adapter({ apiEndpoint: 'https://generativelanguage.googleapis.com' }).listModels()
        ).resolves.toEqual([{ id: 'gemini-legacy', name: 'gemini-legacy' }]);
    });

    it('user gets a model kept when the endpoint sent a null capability list', async () => {
        tauriFetchMock.mockResolvedValue(
            modelsResponse([{ name: 'models/gemini-legacy', supportedGenerationMethods: null }])
        );

        await expect(
            adapter({ apiEndpoint: 'https://generativelanguage.googleapis.com' }).listModels()
        ).resolves.toEqual([{ id: 'gemini-legacy', name: 'gemini-legacy' }]);
    });

    it('user gets the capability check ignoring the endpoint letter case', async () => {
        tauriFetchMock.mockResolvedValue(
            modelsResponse([
                { name: 'models/gemini-x', supportedGenerationMethods: ['GenerateContent'] },
            ])
        );

        const models = await adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
        }).listModels();

        expect(models.map((model) => model.id)).toEqual(['gemini-x']);
    });

    it('user gets an empty list when the endpoint offers no models', async () => {
        tauriFetchMock.mockResolvedValue(modelsResponse([]));

        await expect(
            adapter({ apiEndpoint: 'https://generativelanguage.googleapis.com' }).listModels()
        ).resolves.toEqual([]);
    });

    it('user is told the model list was malformed instead of seeing a blank picker', async () => {
        tauriFetchMock.mockResolvedValue(
            new Response(JSON.stringify({ data: [] }), { status: 200 })
        );

        await expect(
            adapter({ apiEndpoint: 'https://generativelanguage.googleapis.com' }).listModels()
        ).rejects.toThrow();
    });

    it('user gets the api key sent in the header Gemini expects', async () => {
        tauriFetchMock.mockResolvedValue(modelsResponse([]));

        await adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
            apiKey: 'goog-key',
        }).listModels();

        expect(tauriFetchMock).toHaveBeenCalledWith(
            'https://generativelanguage.googleapis.com/v1beta/models',
            expect.objectContaining({
                headers: expect.objectContaining({ 'x-goog-api-key': 'goog-key' }),
            })
        );
    });

    it('user gets no api key header sent when the endpoint needs none', async () => {
        tauriFetchMock.mockResolvedValue(modelsResponse([]));

        await adapter({ apiEndpoint: 'https://generativelanguage.googleapis.com' }).listModels();

        const requestHeaders = tauriFetchMock.mock.calls[0]![1].headers as Record<string, string>;
        expect(requestHeaders['x-goog-api-key']).toBeUndefined();
    });

    it('user gets their own headers sent alongside the Google one', async () => {
        tauriFetchMock.mockResolvedValue(modelsResponse([]));

        await adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
            config: { headers: { 'x-org': 'acme' } },
        }).listModels();

        const requestHeaders = tauriFetchMock.mock.calls[0]![1].headers as Record<string, string>;
        expect(requestHeaders['x-org']).toBe('acme');
    });

    it('user gets the connection reported as working when models load', async () => {
        tauriFetchMock.mockResolvedValue(modelsResponse([{ name: 'models/gemini-pro' }]));

        await expect(
            adapter({ apiEndpoint: 'https://generativelanguage.googleapis.com' }).testConnection()
        ).resolves.toBe(true);
    });

    it('user gets the connection reported as broken when the key is rejected', async () => {
        tauriFetchMock.mockResolvedValue(new Response('denied', { status: 401 }));

        await expect(
            adapter({ apiEndpoint: 'https://generativelanguage.googleapis.com' }).testConnection()
        ).resolves.toBe(false);
    });
});

describe('user sees a Gemini failure explained', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('user is told they ran out of quota rather than given a raw error', () => {
        const error = adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
        }).classifyError({
            statusCode: 429,
            responseBody: JSON.stringify({
                error: {
                    code: 429,
                    message: 'Quota exceeded for quota metric',
                    status: 'RESOURCE_EXHAUSTED',
                },
            }),
            message: 'quota',
        });

        expect(error?.code).toBe(AiErrorCode.RATE_LIMIT);
        expect(error?.message).toBe('Quota exceeded for quota metric');
    });

    it('user is told their key is not allowed to use the model', () => {
        const error = adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
        }).classifyError({
            statusCode: 403,
            responseBody: JSON.stringify({
                error: {
                    code: 403,
                    message: 'Permission denied on resource',
                    status: 'PERMISSION_DENIED',
                },
            }),
            message: 'forbidden',
        });

        expect(error?.code).toBe(AiErrorCode.UNAUTHORIZED);
        expect(error?.message).toBe('Permission denied on resource');
    });

    it('user gets a structured Google error without a message still classified', () => {
        const error = adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
        }).classifyError({
            statusCode: 429,
            data: { error: { status: 'RESOURCE_EXHAUSTED' } },
            message: 'HTTP 429',
        });

        expect(error?.code).toBe(AiErrorCode.RATE_LIMIT);
    });

    it('user gets an error status Google does not name left to the shared mapping', () => {
        const error = adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
        }).classifyError({
            statusCode: 400,
            responseBody: JSON.stringify({
                error: { code: 400, message: 'bad request', status: 'INVALID_ARGUMENT' },
            }),
            message: 'bad request',
        });

        expect(error).toBeNull();
    });

    it('user gets a failure with no body classified by its status', () => {
        const error = adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
        }).classifyError({
            statusCode: 503,
            message: 'HTTP 503',
        });

        expect(error?.code).toBe(AiErrorCode.SERVICE_UNAVAILABLE);
    });

    it('user gets a non-object body classified by its status', () => {
        const error = adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
        }).classifyError({
            statusCode: 502,
            responseBody: 'gateway error',
            message: 'failed',
        });

        expect(error?.code).toBe(AiErrorCode.BAD_GATEWAY);
    });

    it('user gets an error field that is not an object classified by its status', () => {
        const error = adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
        }).classifyError({
            statusCode: 504,
            responseBody: JSON.stringify({ error: 'plain text' }),
            message: 'failed',
        });

        expect(error?.code).toBe(AiErrorCode.GATEWAY_TIMEOUT);
    });

    it('user gets a body with no error field classified by its status', () => {
        const error = adapter({
            apiEndpoint: 'https://generativelanguage.googleapis.com',
        }).classifyError({
            statusCode: 500,
            responseBody: JSON.stringify({ message: 'top level' }),
            message: 'failed',
        });

        expect(error?.code).toBe(AiErrorCode.API_ERROR);
    });

    it('user gets an unrelated failure left unclassified', () => {
        expect(
            adapter({
                apiEndpoint: 'https://generativelanguage.googleapis.com',
            }).classifyError(new Error('plain'))
        ).toBeNull();
    });
});
