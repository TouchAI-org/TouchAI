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
        contextCalibrationKey: 'opaque-session-key',
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

describe('given provider requests with context compaction budgets', () => {
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

    it('user sends OpenAI requests and keeps the original tool order without cache routing hints', async () => {
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
        expect(firstBody.prompt_cache_key).toBeUndefined();
        expect(secondBody.prompt_cache_key).toBeUndefined();
        expect(
            firstBody.tools.map((tool: { function: { name: string } }) => tool.function.name)
        ).toEqual(['z_read', 'a_search']);
        expect(
            secondBody.tools.map((tool: { function: { name: string } }) => tool.function.name)
        ).toEqual(['a_search', 'z_read']);
        expect(Object.keys(firstBody.tools[0].function.parameters.properties)).toEqual(['z', 'a']);
        expect(first.tools?.[0]?.name).toBe('z_read');
    });

    it('user sends an Anthropic request and receives no added cache markers on messages or tools', async () => {
        const provider = new AnthropicProviderAdapter({
            apiEndpoint: 'https://example.test/v1',
            apiKey: 'test-key',
        });
        await expect(provider.request(input())).rejects.toThrow('fixture rejection');
        const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
        expect(body.system).toHaveLength(1);
        expect(body.tools).toHaveLength(2);
        expect(body.messages).toHaveLength(1);
        expect(JSON.stringify(body)).not.toContain('cache_control');
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

    it('user requests OpenAI reasoning with a compaction budget and keeps the selected reasoning level', async () => {
        const provider = new OpenAIProviderAdapter({
            apiEndpoint: 'https://example.test/v1',
            config: { reasoning: { format: 'openai', mode: 'passthrough' } },
        });
        await expect(provider.request({ ...input(), reasoningLevel: 'high' })).rejects.toThrow(
            'fixture rejection'
        );
        const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
        expect(body.prompt_cache_key).toBeUndefined();
        expect(body.reasoning_effort).toBe('high');
    });
});
