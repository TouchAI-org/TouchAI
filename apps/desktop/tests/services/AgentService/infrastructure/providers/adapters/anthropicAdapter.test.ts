import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiErrorCode } from '@/services/AgentService/contracts/errors';
import { AnthropicProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/anthropic';

/**
 * Anthropic's API differs from the OpenAI shape in the places that matter to a user: the base
 * URL has to end in `/v1` for the official host, discovery needs `x-api-key` plus a version
 * header, and its failures use its own error types.
 *
 * Only the network boundary is mocked; URL building, header assembly, model parsing and error
 * classification all run for real.
 */

const { tauriFetchMock } = vi.hoisted(() => ({ tauriFetchMock: vi.fn() }));

vi.mock('@/services/AgentService/infrastructure/providers/ai-sdk/tauriFetch', () => ({
    createTauriFetch: () => tauriFetchMock,
}));

function adapter(config: { apiEndpoint: string; apiKey?: string; config?: unknown }) {
    return new AnthropicProviderAdapter(config as never);
}

describe('user connects to an Anthropic-compatible endpoint', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('user gets the official host address given the versioned path it expects', () => {
        const targets = adapter({ apiEndpoint: 'https://api.anthropic.com' }).getApiTargets();

        expect(targets.sdkBaseUrl).toBe('https://api.anthropic.com/v1');
        expect(targets.generationTarget).toBe('https://api.anthropic.com/v1/messages');
        expect(targets.discoveryTarget).toBe('https://api.anthropic.com/v1/models');
    });

    it('user gets the official host with only a trailing slash also versioned', () => {
        const targets = adapter({ apiEndpoint: 'https://api.anthropic.com/' }).getApiTargets();

        expect(targets.sdkBaseUrl).toBe('https://api.anthropic.com/v1');
    });

    it('user gets a gateway address that already has a path used exactly as given', () => {
        // A gateway that mounts the API under /anthropic/v1 would break if /v1 were appended.
        const targets = adapter({
            apiEndpoint: 'https://gateway.example.com/anthropic/v1',
        }).getApiTargets();

        expect(targets.sdkBaseUrl).toBe('https://gateway.example.com/anthropic/v1');
        expect(targets.generationTarget).toBe('https://gateway.example.com/anthropic/v1/messages');
        expect(targets.discoveryTarget).toBe('https://gateway.example.com/anthropic/v1/models');
    });

    it('user gets an address that cannot be parsed still versioned rather than dropped', () => {
        const targets = adapter({ apiEndpoint: 'not a url' }).getApiTargets();

        expect(targets.sdkBaseUrl).toBe('not a url/v1');
    });

    it('user gets no request target at all when the endpoint is empty', () => {
        const targets = adapter({ apiEndpoint: '' }).getApiTargets();

        expect(targets).toEqual({
            normalizedBaseUrl: '',
            sdkBaseUrl: '',
            generationTarget: '',
            discoveryTarget: '',
        });
    });

    it('user gets the trailing slash removed from the address they configured', () => {
        const targets = adapter({ apiEndpoint: 'https://api.anthropic.com/v1//' }).getApiTargets();

        expect(targets.normalizedBaseUrl).toBe('https://api.anthropic.com/v1');
        expect(targets.sdkBaseUrl).toBe('https://api.anthropic.com/v1');
    });
});

describe('user lists the models an Anthropic endpoint offers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('user gets the model list with the display names the endpoint sent', async () => {
        tauriFetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: [
                        { id: 'claude-3-5-sonnet', display_name: 'Claude 3.5 Sonnet' },
                        { id: 'claude-3-haiku', display_name: 'Claude 3 Haiku' },
                    ],
                }),
                { status: 200 }
            )
        );

        const models = await adapter({ apiEndpoint: 'https://api.anthropic.com' }).listModels();

        expect(models).toEqual([
            { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
            { id: 'claude-3-haiku', name: 'Claude 3 Haiku' },
        ]);
    });

    it('user gets the model id used as its name when the endpoint sent no display name', async () => {
        tauriFetchMock.mockResolvedValue(
            new Response(JSON.stringify({ data: [{ id: 'claude-3-opus' }] }), { status: 200 })
        );

        await expect(
            adapter({ apiEndpoint: 'https://api.anthropic.com' }).listModels()
        ).resolves.toEqual([{ id: 'claude-3-opus', name: 'claude-3-opus' }]);
    });

    it('user gets the camel-case display name accepted from a compatible gateway', async () => {
        tauriFetchMock.mockResolvedValue(
            new Response(JSON.stringify({ data: [{ id: 'claude-x', displayName: 'Claude X' }] }), {
                status: 200,
            })
        );

        await expect(
            adapter({ apiEndpoint: 'https://api.anthropic.com' }).listModels()
        ).resolves.toEqual([{ id: 'claude-x', name: 'Claude X' }]);
    });

    it('user gets an empty list when the endpoint offers no models', async () => {
        tauriFetchMock.mockResolvedValue(
            new Response(JSON.stringify({ data: [] }), { status: 200 })
        );

        await expect(
            adapter({ apiEndpoint: 'https://api.anthropic.com' }).listModels()
        ).resolves.toEqual([]);
    });

    it('user is told the model list was malformed instead of seeing a blank picker', async () => {
        tauriFetchMock.mockResolvedValue(
            new Response(JSON.stringify({ models: [] }), { status: 200 })
        );

        await expect(
            adapter({ apiEndpoint: 'https://api.anthropic.com' }).listModels()
        ).rejects.toThrow();
    });

    it('user gets the api key and the api version sent when discovering models', async () => {
        tauriFetchMock.mockResolvedValue(
            new Response(JSON.stringify({ data: [] }), { status: 200 })
        );

        await adapter({ apiEndpoint: 'https://api.anthropic.com', apiKey: 'sk-ant' }).listModels();

        expect(tauriFetchMock).toHaveBeenCalledWith(
            'https://api.anthropic.com/v1/models',
            expect.objectContaining({
                headers: expect.objectContaining({
                    'x-api-key': 'sk-ant',
                    'anthropic-version': '2023-06-01',
                }),
            })
        );
    });

    it('user gets no empty api key header sent when the endpoint needs none', async () => {
        tauriFetchMock.mockResolvedValue(
            new Response(JSON.stringify({ data: [] }), { status: 200 })
        );

        await adapter({ apiEndpoint: 'https://api.anthropic.com' }).listModels();

        const requestHeaders = tauriFetchMock.mock.calls[0]![1].headers as Record<string, string>;
        expect(requestHeaders['x-api-key']).toBeUndefined();
        expect(requestHeaders['anthropic-version']).toBe('2023-06-01');
    });

    it('user gets their own headers sent alongside the Anthropic ones', async () => {
        tauriFetchMock.mockResolvedValue(
            new Response(JSON.stringify({ data: [] }), { status: 200 })
        );

        await adapter({
            apiEndpoint: 'https://api.anthropic.com',
            config: { headers: { 'x-org': 'acme' } },
        }).listModels();

        const requestHeaders = tauriFetchMock.mock.calls[0]![1].headers as Record<string, string>;
        expect(requestHeaders['x-org']).toBe('acme');
        expect(requestHeaders['anthropic-version']).toBe('2023-06-01');
    });

    it('user gets the connection reported as working when models load', async () => {
        tauriFetchMock.mockResolvedValue(
            new Response(JSON.stringify({ data: [{ id: 'claude-3' }] }), { status: 200 })
        );

        await expect(
            adapter({ apiEndpoint: 'https://api.anthropic.com' }).testConnection()
        ).resolves.toBe(true);
    });
});

describe('user sees an Anthropic failure explained', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('user is told the service is overloaded rather than given a raw error', () => {
        const error = adapter({ apiEndpoint: 'https://api.anthropic.com' }).classifyError({
            statusCode: 529,
            responseBody: JSON.stringify({
                type: 'error',
                error: { type: 'overloaded_error', message: 'Overloaded' },
            }),
            message: 'overloaded',
        });

        expect(error?.code).toBe(AiErrorCode.SERVICE_UNAVAILABLE);
        expect(error?.message).toBe('Overloaded');
    });

    it('user is told they hit the rate limit', () => {
        const error = adapter({ apiEndpoint: 'https://api.anthropic.com' }).classifyError({
            statusCode: 429,
            responseBody: JSON.stringify({
                type: 'error',
                error: { type: 'rate_limit_error', message: 'Slow down' },
            }),
            message: 'rate limited',
        });

        expect(error?.code).toBe(AiErrorCode.RATE_LIMIT);
        expect(error?.message).toBe('Slow down');
    });

    it('user is told their api key is invalid', () => {
        const error = adapter({ apiEndpoint: 'https://api.anthropic.com' }).classifyError({
            statusCode: 401,
            responseBody: JSON.stringify({
                type: 'error',
                error: { type: 'authentication_error', message: 'invalid x-api-key' },
            }),
            message: 'unauthorized',
        });

        expect(error?.code).toBe(AiErrorCode.INVALID_API_KEY);
        expect(error?.message).toBe('invalid x-api-key');
    });

    it('user gets a structured Anthropic error without a message still classified', () => {
        const error = adapter({ apiEndpoint: 'https://api.anthropic.com' }).classifyError({
            statusCode: 529,
            data: { type: 'error', error: { type: 'overloaded_error' } },
            message: 'HTTP 529',
        });

        expect(error?.code).toBe(AiErrorCode.SERVICE_UNAVAILABLE);
    });

    it('user gets an error type the adapter does not know left to the shared mapping', () => {
        const error = adapter({ apiEndpoint: 'https://api.anthropic.com' }).classifyError({
            statusCode: 400,
            responseBody: JSON.stringify({
                type: 'error',
                error: { type: 'invalid_request_error', message: 'bad request' },
            }),
            message: 'bad request',
        });

        // 400 is not one the shared map turns into a typed error, so the failure stays generic.
        expect(error).toBeNull();
    });

    it('user gets a failure with no body classified by its status', () => {
        const error = adapter({ apiEndpoint: 'https://api.anthropic.com' }).classifyError({
            statusCode: 500,
            message: 'HTTP 500',
        });

        expect(error?.code).toBe(AiErrorCode.API_ERROR);
    });

    it('user gets a non-object body classified by its status', () => {
        const error = adapter({ apiEndpoint: 'https://api.anthropic.com' }).classifyError({
            statusCode: 503,
            responseBody: 'plain text failure',
            message: 'failed',
        });

        expect(error?.code).toBe(AiErrorCode.SERVICE_UNAVAILABLE);
    });

    it('user gets an error field that is not an object classified by its status', () => {
        const error = adapter({ apiEndpoint: 'https://api.anthropic.com' }).classifyError({
            statusCode: 502,
            responseBody: JSON.stringify({ error: 'a string' }),
            message: 'failed',
        });

        expect(error?.code).toBe(AiErrorCode.BAD_GATEWAY);
    });

    it('user gets a body with no error field classified by its status', () => {
        const error = adapter({ apiEndpoint: 'https://api.anthropic.com' }).classifyError({
            statusCode: 504,
            responseBody: JSON.stringify({ type: 'error' }),
            message: 'failed',
        });

        expect(error?.code).toBe(AiErrorCode.GATEWAY_TIMEOUT);
    });

    it('user gets a connection failure with no response classified by status only', () => {
        const error = adapter({ apiEndpoint: 'https://api.anthropic.com' }).classifyError({
            statusCode: 401,
            message: 'HTTP 401',
        });

        expect(error?.code).toBe(AiErrorCode.UNAUTHORIZED);
    });
});
