import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiRequestOptions } from '@/services/AgentService/contracts/protocol';
import { AnthropicProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/anthropic';
import { OpenAIProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/openai';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/services/AgentService/infrastructure/providers/ai-sdk/tauriFetch', () => ({
    createTauriFetch: () => fetchMock,
}));

function input(): AiRequestOptions {
    return {
        model: 'test-model',
        promptCacheKey: 'opaque-session-key',
        maxOutputTokens: 4096,
        messages: [
            { role: 'system', content: 'Stable instructions' },
            { role: 'user', content: 'First request' },
        ],
        tools: [
            {
                name: 'z_read',
                description: 'Read',
                input_schema: {
                    type: 'object',
                    properties: { z: { type: 'string' }, a: { type: 'string' } },
                },
            },
            {
                name: 'a_search',
                description: 'Search',
                input_schema: { type: 'object', properties: {} },
            },
        ],
    };
}

describe('given provider requests with reusable context', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    type: 'error',
                    error: { type: 'invalid_request_error', message: 'fixture rejection' },
                }),
                { status: 400 }
            )
        );
    });

    it('user sends a stable cache key and deterministic tool definitions to OpenAI', async () => {
        const provider = new OpenAIProviderAdapter({
            apiEndpoint: 'https://example.test/v1',
            config: { reasoning: { format: 'openai' } },
        });
        const first = input();
        await expect(provider.request(first)).rejects.toThrow('fixture rejection');
        const firstBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
        const second = input();
        second.tools!.reverse();
        second.tools![1]!.input_schema.properties = {
            a: { type: 'string' },
            z: { type: 'string' },
        };
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ error: { message: 'fixture rejection' } }), {
                status: 400,
            })
        );
        await expect(provider.request(second)).rejects.toThrow('fixture rejection');
        const secondBody = JSON.parse(fetchMock.mock.calls[1]![1].body);
        expect(firstBody.prompt_cache_key).toBe('opaque-session-key');
        expect(JSON.stringify(firstBody.tools)).toBe(JSON.stringify(secondBody.tools));
        expect(first.tools?.[0]?.name).toBe('z_read');
    });

    it('user sends bounded Anthropic cache markers on reusable system tools and conversation', async () => {
        const provider = new AnthropicProviderAdapter({
            apiEndpoint: 'https://example.test/v1',
            apiKey: 'test-key',
        });
        await expect(provider.request(input())).rejects.toThrow('fixture rejection');
        const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
        expect(body.system.at(-1).cache_control).toEqual({ type: 'ephemeral' });
        expect(body.tools.at(-1).cache_control).toEqual({ type: 'ephemeral' });
        expect(body.messages.at(-1).content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
        expect(JSON.stringify(body).match(/cache_control/g)?.length).toBeLessThanOrEqual(4);
    });

    it('user keeps tool definitions while disabling their execution for a summary', async () => {
        const provider = new OpenAIProviderAdapter({
            apiEndpoint: 'https://example.test/v1',
            config: { reasoning: { format: 'openai' } },
        });
        await expect(provider.request({ ...input(), toolChoice: 'none' })).rejects.toThrow(
            'fixture rejection'
        );
        const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
        expect(body.tools).toHaveLength(2);
        expect(body.tool_choice).toBe('none');
        expect(body.max_tokens ?? body.max_completion_tokens).toBe(4096);
    });

    it.each([4096, 1000])(
        'user keeps Anthropic thinking inside the total output budget of %s tokens',
        async (budget) => {
            const provider = new AnthropicProviderAdapter({
                apiEndpoint: 'https://example.test/v1',
                apiKey: 'test-key',
                config: { reasoning: { mode: 'passthrough' } },
            });
            await expect(
                provider.request({
                    ...input(),
                    model: 'claude-sonnet-4-20250514',
                    maxOutputTokens: budget,
                    reasoningLevel: 'high',
                })
            ).rejects.toThrow('fixture rejection');
            const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
            expect(body.max_tokens).toBe(budget);
            if (budget === 1000) expect(body.thinking.type).toBe('disabled');
            else {
                expect(body.thinking.type).toBe('enabled');
                expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
            }
        }
    );

    it('user keeps OpenAI reasoning settings when a cache routing key is added', async () => {
        const provider = new OpenAIProviderAdapter({
            apiEndpoint: 'https://example.test/v1',
            config: { reasoning: { format: 'openai', mode: 'passthrough' } },
        });
        await expect(provider.request({ ...input(), reasoningLevel: 'high' })).rejects.toThrow(
            'fixture rejection'
        );
        const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
        expect(body.prompt_cache_key).toBe('opaque-session-key');
        expect(body.reasoning_effort).toBe('high');
    });
});
