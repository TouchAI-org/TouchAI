import { compatibleResponse, createCompatibleProvider } from '@tests/utils/provider';
import { AiErrorCode } from '@touchai/models/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriFetchMock = vi.fn<typeof fetch>();
const provider = (config: Parameters<typeof createCompatibleProvider>[1] = {}) =>
    createCompatibleProvider(tauriFetchMock, config);

beforeEach(() => {
    tauriFetchMock.mockReset();
});

describe('given a saved provider connection profile', () => {
    it('user sees the trailing slash removed from the advertised endpoints', () => {
        expect(provider().getApiTargets().normalizedBaseUrl).toBe('https://api.example.com/v1');
    });
    it('user sends a trimmed API key and keeps custom headers during discovery', async () => {
        tauriFetchMock.mockResolvedValue(Response.json({ data: [] }));
        await provider({ config: { headers: { 'x-org': 'acme' } } }).listModels();
        const headers = new Headers(tauriFetchMock.mock.calls[0]?.[1]?.headers);
        expect(headers.get('authorization')).toBe('Bearer secret');
        expect(headers.get('x-org')).toBe('acme');
    });
});

describe('user lists the models a provider offers', () => {
    it('user gets the model list parsed from the response', async () => {
        tauriFetchMock.mockResolvedValue(
            new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }), {
                status: 200,
            })
        );

        const models = await provider().listModels();

        expect(models).toEqual([
            { id: 'gpt-4o', name: 'gpt-4o' },
            { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
        ]);
    });

    it('user gets an empty list when the provider returns no models', async () => {
        tauriFetchMock.mockResolvedValue(Response.json({ data: [] }));

        // An empty body is not an error; it just means the provider lists nothing.
        await expect(provider().listModels()).resolves.toEqual([]);
    });

    it('user gets a clear error when the provider rejects the request', async () => {
        tauriFetchMock.mockResolvedValue(new Response('denied', { status: 401 }));

        await expect(provider().listModels()).rejects.toThrow('HTTP 401');
    });

    it('user gets a clear error when the response is not JSON', async () => {
        tauriFetchMock.mockResolvedValue(
            new Response('<html>gateway</html>', {
                status: 200,
                headers: { 'content-type': 'text/html' },
            })
        );

        // A gateway HTML page must say so rather than surface a bare JSON parse error.
        await expect(provider().listModels()).rejects.toThrow(/Expected JSON response/);
    });

    it('user gets no request made when the base url is empty', async () => {
        const instance = provider({ apiEndpoint: '' });

        await expect(instance.listModels()).rejects.toThrow('Provider base URL is empty');
        expect(tauriFetchMock).not.toHaveBeenCalled();
    });

    it('user gets the connection reported as working when models load', async () => {
        tauriFetchMock.mockResolvedValue(
            new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 })
        );

        await expect(provider().testConnection()).resolves.toBe(true);
    });

    it('user gets the connection reported as broken when the request fails', async () => {
        tauriFetchMock.mockRejectedValue(new Error('offline'));

        // A failed test connection is a result, not an exception the UI has to catch.
        await expect(provider().testConnection()).resolves.toBe(false);
    });
});

describe('user sees a provider failure explained', () => {
    it('user gets an invalid api key named from the provider error code', () => {
        const error = provider().classifyError?.({
            statusCode: 401,
            responseBody: JSON.stringify({ error: { code: 'invalid_api_key' } }),
            message: 'unauthorized',
        });

        expect(error?.code).toBe(AiErrorCode.INVALID_API_KEY);
    });

    it('user gets an exhausted quota reported as a rate limit', () => {
        const error = provider().classifyError?.({
            statusCode: 429,
            responseBody: JSON.stringify({ error: { type: 'insufficient_quota' } }),
            message: 'quota',
        });

        expect(error?.code).toBe(AiErrorCode.RATE_LIMIT);
    });

    it('user gets the provider message kept rather than replaced', () => {
        const error = provider().classifyError?.({
            statusCode: 429,
            responseBody: JSON.stringify({
                error: { type: 'insufficient_quota', message: 'No credit left' },
            }),
            message: 'quota',
        });

        // The provider's own wording tells the user what to fix.
        expect(error?.message).toBe('No credit left');
    });

    it('user gets a status mapped when the body carries no error code', () => {
        const error = provider().classifyError?.({
            statusCode: 503,
            responseBody: 'busy',
            message: 'Service busy',
        });

        expect(error?.code).toBe(AiErrorCode.SERVICE_UNAVAILABLE);
    });

    it('user gets a body that is not JSON still classified by its status', () => {
        const error = provider().classifyError?.({
            statusCode: 502,
            responseBody: '<html>bad gateway</html>',
            message: 'Bad gateway',
        });

        // Gateways return HTML on failure; the status is still the useful signal.
        expect(error?.code).toBe(AiErrorCode.BAD_GATEWAY);
    });

    it('user gets no error classification for an unrelated failure', () => {
        expect(provider().classifyError?.(new Error('plain'))).toBeNull();
    });
});

describe('given provider reasoning options are sent through the real SDK', () => {
    it.each([
        {
            label: 'unspecified metadata',
            supportsReasoning: undefined,
            config: {},
            expected: undefined,
        },
        {
            label: 'explicitly supported',
            supportsReasoning: true,
            config: { reasoning: { format: 'openai' as const } },
            expected: 'high',
        },
        {
            label: 'explicitly unsupported',
            supportsReasoning: false,
            config: { reasoning: { format: 'openai' as const } },
            expected: undefined,
        },
    ])(
        'user sends the permitted reasoning effort when the model is $label',
        async ({ supportsReasoning, config, expected }) => {
            tauriFetchMock.mockResolvedValue(compatibleResponse());
            const connection = provider({ config });
            try {
                expect(
                    (
                        await connection.request({
                            model: 'fixture',
                            messages: [{ role: 'user', content: 'hello' }],
                            supportsReasoning,
                            reasoningLevel: 'high',
                            reasoningOptions:
                                supportsReasoning === undefined
                                    ? undefined
                                    : [{ type: 'effort', values: ['low', 'medium', 'high'] }],
                        })
                    ).content
                ).toBe('fixture answer');
                const body = JSON.parse(String(tauriFetchMock.mock.calls[0]?.[1]?.body));
                expect(body.reasoning_effort).toBe(expected);
            } finally {
                connection.dispose();
            }
        }
    );
});
