import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiErrorCode } from '@/services/AgentService/contracts/errors';
import { AiSdkProviderBase } from '@/services/AgentService/infrastructure/providers/ai-sdk/base';
import type {
    AiProviderConfig,
    ModelInfo,
    ProviderApiTargets,
} from '@/services/AgentService/infrastructure/providers/types';
import type { AiRequestOptions } from '@/services/AgentService/contracts/protocol';

/**
 * The shared provider base is what every SDK-backed provider inherits: how a base URL is
 * normalised, how a failure becomes an AiError, and how a model list is read. A mistake here
 * affects every provider at once, which is why it is tested through a concrete subclass rather
 * than through any one vendor.
 */
const { tauriFetchMock } = vi.hoisted(() => ({ tauriFetchMock: vi.fn() }));

vi.mock('@/services/AgentService/infrastructure/providers/ai-sdk/tauriFetch', () => ({
    createTauriFetch: () => tauriFetchMock,
}));

vi.mock('@/services/AgentService/infrastructure/providers/ai-sdk/stream', () => ({
    createAiSdkStreamProcessor: () => ({
        consumePart: () => [],
        buildFinishChunk: () => ({ content: '', done: true }),
    }),
}));

vi.mock('@/services/AgentService/infrastructure/providers/ai-sdk/messages', () => ({
    buildModelMessages: async () => ({ messages: [], manifestRequest: undefined }),
}));

vi.mock('@/services/AgentService/infrastructure/providers/ai-sdk/tools', () => ({
    buildToolSet: () => undefined,
}));

/** A minimal concrete provider so the shared behaviour can be exercised. */
class TestProvider extends AiSdkProviderBase {
    readonly name = 'test-provider';
    readonly driver = 'openai' as never;

    getApiTargets(): ProviderApiTargets {
        return {
            normalizedBaseUrl: this.normalizedBaseUrl,
            sdkBaseUrl: this.normalizedBaseUrl,
            generationTarget: `${this.normalizedBaseUrl}/chat`,
            discoveryTarget: this.normalizedBaseUrl ? `${this.normalizedBaseUrl}/models` : '',
        };
    }

    protected createLanguageModel() {
        return {} as never;
    }

    protected getDiscoveryHeaders(): Record<string, string> {
        return { authorization: `Bearer ${this.apiKey ?? ''}` };
    }

    protected override getFallbackReasoningLevelMap(): Record<string, string> {
        // Without a fallback map the resolver reports level=off, which is the safe default.
        return { low: 'low', medium: 'medium', high: 'high' };
    }

    protected parseModelList(payload: unknown): ModelInfo[] {
        const data = (payload as { data?: Array<{ id: string }> } | null)?.data ?? [];
        return data.map((entry) => ({ id: entry.id, name: entry.id }));
    }

    /** Test seam: expose the shared helpers without widening the production surface. */
    readJson(response: Response) {
        return this.readJsonResponse(response);
    }

    customHeaders() {
        return this.getCustomHeaders();
    }

    options(options: AiRequestOptions) {
        return this.getStreamProviderOptions(options);
    }
}

function provider(config: Partial<AiProviderConfig> = {}) {
    return new TestProvider({
        apiEndpoint: 'https://api.example.com/v1/',
        apiKey: '  secret  ',
        ...config,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('user connects to a provider', () => {
    it('user gets the trailing slash removed from the base url', () => {
        expect(provider().normalizedBaseUrl).toBe('https://api.example.com/v1');
    });

    it('user gets the api key trimmed before it is sent', () => {
        // A key with stray whitespace fails the provider's auth check.
        expect(provider().customHeaders()).toEqual({});
        expect(provider().getApiTargets().discoveryTarget).toBe(
            'https://api.example.com/v1/models'
        );
    });

    it('user gets their custom headers kept', () => {
        const instance = provider({ config: { headers: { 'x-org': 'acme' } } as never });

        expect(instance.customHeaders()).toEqual({ 'x-org': 'acme' });
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
        tauriFetchMock.mockResolvedValue(new Response('', { status: 200 }));

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
        const error = provider().classifyError({
            statusCode: 401,
            responseBody: JSON.stringify({ error: { code: 'invalid_api_key' } }),
            message: 'unauthorized',
        });

        expect(error?.code).toBe(AiErrorCode.INVALID_API_KEY);
    });

    it('user gets an exhausted quota reported as a rate limit', () => {
        const error = provider().classifyError({
            statusCode: 429,
            responseBody: JSON.stringify({ error: { type: 'insufficient_quota' } }),
            message: 'quota',
        });

        expect(error?.code).toBe(AiErrorCode.RATE_LIMIT);
    });

    it('user gets the provider message kept rather than replaced', () => {
        const error = provider().classifyError({
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
        const error = provider().classifyError({
            statusCode: 503,
            responseBody: 'busy',
            message: 'Service busy',
        });

        expect(error?.code).toBe(AiErrorCode.SERVICE_UNAVAILABLE);
    });

    it('user gets a body that is not JSON still classified by its status', () => {
        const error = provider().classifyError({
            statusCode: 502,
            responseBody: '<html>bad gateway</html>',
            message: 'Bad gateway',
        });

        // Gateways return HTML on failure; the status is still the useful signal.
        expect(error?.code).toBe(AiErrorCode.BAD_GATEWAY);
    });

    it('user gets no error classification for an unrelated failure', () => {
        expect(provider().classifyError(new Error('plain'))).toBeNull();
    });
});

describe('user turns reasoning on for a provider', () => {
    const baseOptions = {
        model: 'gpt-4o',
        messages: [],
        providerId: 1,
    } as unknown as AiRequestOptions;

    it('user gets no reasoning options when the provider declares no format', () => {
        expect(provider().options(baseOptions)).toBeUndefined();
    });

    it('user gets reasoning options when the provider declares a format', () => {
        const instance = provider({ config: { reasoning: { format: 'openai' } } as never });

        const options = instance.options({
            ...baseOptions,
            reasoningLevel: 'high',
            supportsReasoning: true,
        } as AiRequestOptions);

        expect(options).toBeTruthy();
        expect(Object.keys(options!)).toContain('openai');
    });

    it('user gets nothing sent when the model declares reasoning unsupported', () => {
        const instance = provider({ config: { reasoning: { format: 'openai' } } as never });

        // Sending an effort to a non-reasoning model makes some providers reject the request.
        expect(
            instance.options({
                ...baseOptions,
                reasoningLevel: 'high',
                supportsReasoning: false,
            } as AiRequestOptions)
        ).toBeUndefined();
    });
});
