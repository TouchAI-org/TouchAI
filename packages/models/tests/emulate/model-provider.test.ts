import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    AiError,
    AiErrorCode,
    type AiMessage,
    type AiToolDefinition,
    type ModelsHost,
} from '../../src/contracts';
import { AnthropicProviderAdapter } from '../../src/providers/anthropic';
import { OpenAIProviderAdapter } from '../../src/providers/openai';
import { OpenAICompatibleProviderAdapter } from '../../src/providers/openai-compatible';
import { type LocalModelService, startLocalModelService } from './local-model-service';

/**
 * Provider adapters talk to a real HTTP service here, not to a stubbed fetch.
 *
 * A stubbed fetch proves the adapter builds the URL the adapter was written to
 * build. It cannot prove that a whole round trip works: SSE framing parsed by the
 * AI SDK, tool calls encoded back into the next request, or an error body mapped
 * to the code the UI shows. `emulate` answers those requests locally, so this
 * suite covers the contract the desktop app actually depends on without a key or
 * the network.
 */

const MODEL = 'contract-model';
const API_KEY = 'local-contract-key';
const DISCOVERED_MODELS = ['contract-model-a', 'contract-model-b'];

let service: LocalModelService;

beforeAll(async () => {
    service = await startLocalModelService({ models: DISCOVERED_MODELS });
});

afterAll(async () => {
    await service.close();
});

function host(): ModelsHost {
    return {
        fetch: globalThis.fetch,
        remoteRefs: {
            read: async () => null,
            touch: async () => undefined,
            write: async () => undefined,
        },
    };
}

function openAiCompatible() {
    return new OpenAICompatibleProviderAdapter(
        { apiEndpoint: service.endpoint, apiKey: API_KEY },
        host()
    );
}

function openAi() {
    return new OpenAIProviderAdapter({ apiEndpoint: service.endpoint, apiKey: API_KEY }, host());
}

function anthropic() {
    return new AnthropicProviderAdapter({ apiEndpoint: service.endpoint, apiKey: API_KEY }, host());
}

const greeting: AiMessage[] = [{ role: 'user', content: 'hello local model' }];

const weatherTool: AiToolDefinition = {
    name: 'get_weather',
    description: 'Read the current weather for a city.',
    input_schema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
    },
};

describe('user asks a local model service for an answer', () => {
    it('user sees the answer streamed by an OpenAI-compatible endpoint', async () => {
        await service.useRules([
            {
                id: 'greeting',
                match: { textContains: 'hello local model' },
                reply: [{ type: 'text', text: 'Hello from the local endpoint.' }],
            },
        ]);

        const chunks = [];
        for await (const chunk of openAiCompatible().stream({ model: MODEL, messages: greeting })) {
            chunks.push(chunk);
        }

        expect(chunks.map((chunk) => chunk.content).join('')).toBe(
            'Hello from the local endpoint.'
        );
        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.finishReason).toBe('stop');
    });

    it('user sees the answer an OpenAI endpoint returns through its Responses API', async () => {
        await service.useRules([
            {
                id: 'greeting',
                match: { format: 'openai-responses', textContains: 'hello local model' },
                reply: [{ type: 'text', text: 'Hello from the Responses API.' }],
            },
        ]);

        const response = await openAi().request({ model: MODEL, messages: greeting });

        expect(response.content).toBe('Hello from the Responses API.');
        expect(response.finishReason).toBe('stop');
    });

    it('user sees the answer an Anthropic endpoint returns', async () => {
        await service.useRules([
            {
                id: 'greeting',
                match: { format: 'anthropic-messages', textContains: 'hello local model' },
                reply: [{ type: 'text', text: 'Hello from the Messages API.' }],
            },
        ]);

        const response = await anthropic().request({ model: MODEL, messages: greeting });

        expect(response.content).toBe('Hello from the Messages API.');
        expect(response.finishReason).toBe('stop');
    });

    it('user sees the model reasoning before its answer', async () => {
        await service.useRules([
            {
                id: 'reasoning',
                match: { format: 'openai-responses', textContains: 'why is the sky blue' },
                reply: [
                    { type: 'reasoning', text: 'Recall Rayleigh scattering.' },
                    { type: 'text', text: 'Because air scatters short wavelengths.' },
                ],
            },
        ]);

        const chunks = [];
        for await (const chunk of openAi().stream({
            model: MODEL,
            messages: [{ role: 'user', content: 'why is the sky blue' }],
        })) {
            chunks.push(chunk);
        }

        expect(chunks.map((chunk) => chunk.reasoning ?? '').join('')).toBe(
            'Recall Rayleigh scattering.'
        );
        expect(chunks.map((chunk) => chunk.content).join('')).toBe(
            'Because air scatters short wavelengths.'
        );

        const lastReasoning = chunks.reduce(
            (last, chunk, index) => (chunk.reasoning ? index : last),
            -1
        );
        const firstContent = chunks.findIndex((chunk) => Boolean(chunk.content));
        expect(lastReasoning).toBeLessThan(firstContent);
    });
});

describe('user asks a local model service to use a tool', () => {
    it('user sees the tool result answered in the same conversation', async () => {
        await service.useRules([
            {
                id: 'weather-call',
                match: {
                    textContains: 'weather in Paris',
                    tool: 'get_weather',
                    hasToolResult: false,
                },
                reply: [{ type: 'tool_call', name: 'get_weather', arguments: { city: 'Paris' } }],
            },
            {
                id: 'weather-answer',
                match: { hasToolResult: true },
                reply: [{ type: 'text', text: 'The temperature in Paris is 20 C.' }],
            },
        ]);

        const provider = openAiCompatible();
        const toolCalls = [];
        for await (const chunk of provider.stream({
            model: MODEL,
            messages: [{ role: 'user', content: 'weather in Paris' }],
            tools: [weatherTool],
        })) {
            toolCalls.push(...(chunk.toolCalls ?? []));
        }

        const [call] = toolCalls;
        expect(call?.name).toBe('get_weather');
        expect(JSON.parse(call?.arguments ?? '')).toEqual({ city: 'Paris' });

        const answer = await provider.request({
            model: MODEL,
            tools: [weatherTool],
            messages: [
                { role: 'user', content: 'weather in Paris' },
                { role: 'assistant', content: '', tool_calls: toolCalls },
                {
                    role: 'tool',
                    tool_call_id: call?.id ?? '',
                    name: 'get_weather',
                    content: JSON.stringify({ temperatureC: 20 }),
                },
            ],
        });

        expect(answer.content).toBe('The temperature in Paris is 20 C.');
    });
});

describe('user connects to a local model service', () => {
    it('user sees the models an OpenAI endpoint offers', async () => {
        await service.useRules([]);

        const models = await openAiCompatible().listModels();

        for (const id of DISCOVERED_MODELS) {
            expect(models).toContainEqual({ id, name: id });
        }
    });

    it('user sees the models an Anthropic endpoint offers', async () => {
        await service.useRules([]);

        const models = await anthropic().listModels();

        for (const id of DISCOVERED_MODELS) {
            expect(models).toContainEqual({ id, name: id });
        }
    });
});

describe('user hits a failing model service', () => {
    it('user is told to wait when the endpoint rate limits the request', async () => {
        await service.useRules([
            {
                id: 'rate-limit',
                match: { textContains: 'hello local model' },
                error: { status: 429, message: 'Injected rate limit. Retry this request.' },
            },
        ]);

        const error = await openAiCompatible()
            .request({ model: MODEL, messages: greeting })
            .catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(AiError);
        expect((error as AiError).code).toBe(AiErrorCode.RATE_LIMIT);
        expect((error as AiError).message).toContain('Injected rate limit');
    });

    it('user is told the service is overloaded when an Anthropic endpoint answers 529', async () => {
        await service.useRules([
            {
                id: 'overloaded',
                match: { textContains: 'hello local model' },
                error: { status: 529, message: 'Injected overload. Try again shortly.' },
            },
        ]);

        const error = await anthropic()
            .request({ model: MODEL, messages: greeting })
            .catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(AiError);
        expect((error as AiError).code).toBe(AiErrorCode.SERVICE_UNAVAILABLE);
        expect((error as AiError).message).toContain('Injected overload');
    });

    it('user gets an answer on the next request after a rate limit', async () => {
        await service.useRules([
            {
                id: 'rate-limit-once',
                match: { textContains: 'hello local model' },
                times: 1,
                error: { status: 429, message: 'Injected rate limit. Retry this request.' },
            },
            {
                id: 'greeting',
                match: { textContains: 'hello local model' },
                reply: [{ type: 'text', text: 'Recovered after the rate limit.' }],
            },
        ]);

        const provider = openAiCompatible();
        await expect(provider.request({ model: MODEL, messages: greeting })).rejects.toBeInstanceOf(
            AiError
        );

        await expect(provider.request({ model: MODEL, messages: greeting })).resolves.toMatchObject(
            {
                content: 'Recovered after the rate limit.',
                finishReason: 'stop',
            }
        );
    });
});
