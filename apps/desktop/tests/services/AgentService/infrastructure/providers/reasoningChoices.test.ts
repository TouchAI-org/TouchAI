import { describe, expect, it, vi } from 'vitest';

import type { AiRequestOptions } from '@/services/AgentService/contracts/protocol';
import { normalizeReasoningOptions } from '@/services/AgentService/contracts/reasoning';
import snapshot from '@/services/AgentService/infrastructure/modelMetadata/snapshot.json';
import { AnthropicProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/anthropic';
import { AnthropicCompatibleProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/anthropic-compatible';
import { DeepSeekProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/deepseek';
import { MiniMaxProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/minimax';
import { MoonshotProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/moonshot';
import { OpenAIProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/openai';
import { OpenAICompatibleProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/openai-compatible';
import { XaiProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/xai';
import { ZhipuProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/zhipu';
import type { AiProvider } from '@/services/AgentService/infrastructure/providers/types';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/services/AgentService/infrastructure/providers/ai-sdk/tauriFetch', () => ({
    createTauriFetch: () => fetchMock,
}));

class RequestProbe extends OpenAICompatibleProviderAdapter {
    outgoing(options: AiRequestOptions) {
        return this.getStreamProviderOptions(options);
    }
}

async function sentBody(provider: AiProvider, options: AiRequestOptions) {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
        new Response(
            JSON.stringify({
                type: 'error',
                error: { type: 'invalid_request_error', message: 'fixture rejection' },
            }),
            { status: 400 }
        )
    );
    await expect(provider.request(options)).rejects.toThrow('fixture rejection');
    expect(fetchMock).toHaveBeenCalledOnce();
    return JSON.parse(fetchMock.mock.calls[0]![1].body);
}

describe('given a model picker using the provider reasoning contract', () => {
    it.each(['claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805'] as const)(
        'user with %s metadata claiming effort sends only supported token budgets',
        async (model) => {
            const provider = new AnthropicProviderAdapter({
                apiKey: 'fixture-key',
                apiEndpoint: 'https://fixture.invalid/v1',
            });
            const metadata = snapshot.models[`anthropic/${model}`];
            const input = {
                model,
                supportsReasoning: true,
                reasoningOptions: normalizeReasoningOptions(metadata.reasoning_options),
            };
            const defaultBody = await sentBody(provider, {
                ...input,
                messages: [{ role: 'user', content: 'hello' }],
            });
            expect(defaultBody.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
            expect(defaultBody.output_config?.effort).toBeUndefined();
            const budgets = [];
            for (const level of provider
                .getReasoningLevels(input)
                .filter((value) => value !== 'off')) {
                const body = await sentBody(provider, {
                    ...input,
                    messages: [{ role: 'user', content: 'hello' }],
                    reasoningLevel: level,
                });
                expect(body.output_config?.effort).toBeUndefined();
                budgets.push(body.thinking.budget_tokens);
            }
            expect(new Set(budgets).size).toBe(budgets.length);
            expect(budgets.length).toBeGreaterThan(1);
        }
    );

    it.each(['claude-opus-4-5', 'claude-opus-4-5-20251101'] as const)(
        'user choosing or defaulting depth on %s sends an effort supported by that model',
        async (model) => {
            const provider = new AnthropicProviderAdapter({
                apiKey: 'fixture-key',
                apiEndpoint: 'https://fixture.invalid/v1',
            });
            const metadata = snapshot.models[`anthropic/${model}`];
            const input = {
                model,
                supportsReasoning: true,
                reasoningOptions: normalizeReasoningOptions(metadata.reasoning_options),
            };
            expect(provider.getReasoningLevels(input)).toEqual(['low', 'medium', 'high']);
            for (const reasoningLevel of [
                undefined,
                'low',
                'medium',
                'high',
                'max',
                'xhigh',
            ] as const) {
                const body = await sentBody(provider, {
                    ...input,
                    messages: [{ role: 'user', content: 'hello' }],
                    reasoningLevel,
                });
                expect(body.output_config.effort).toBe(
                    reasoningLevel === 'low' || reasoningLevel === 'medium'
                        ? reasoningLevel
                        : 'high'
                );
                expect(body.thinking.type).toBe('enabled');
            }
        }
    );

    it.each(['claude-opus-4-6', 'claude-sonnet-4-6'])(
        'user with incomplete metadata on %s cannot send its unsupported xhigh effort',
        async (model) => {
            const provider = new AnthropicProviderAdapter({
                apiKey: 'fixture-key',
                apiEndpoint: 'https://fixture.invalid/v1',
            });
            const input = {
                model,
                supportsReasoning: true,
                reasoningOptions: [{ type: 'toggle' as const }],
            };
            expect(provider.getReasoningLevels(input)).not.toContain('xhigh');
            const body = await sentBody(provider, {
                ...input,
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel: 'xhigh',
            });
            expect(body.output_config.effort).toBe('max');
        }
    );

    it.each(['kimi-k3', 'kimi-k2.5'])(
        'user upgrading to %s with a previous medium override reaches the target SDK transport',
        async (model) => {
            const provider = new MoonshotProviderAdapter({
                apiKey: 'fixture-key',
                apiEndpoint: 'https://fixture.invalid/v1',
                config: { reasoning: { mode: 'passthrough' } },
            });
            const body = await sentBody(provider, {
                model,
                supportsReasoning: true,
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel: 'medium',
            });
            if (model === 'kimi-k3') expect(body.reasoning_effort).toBe('high');
            else {
                expect(body.reasoning_effort).toBeUndefined();
                expect(body.thinking).toEqual({ type: 'enabled' });
            }
        }
    );

    it.each(['MiniMax-M2', 'MiniMax-M2.7-highspeed'] as const)(
        'user selecting %s is not offered depth controls that its transport discards',
        async (model) => {
            const provider = new MiniMaxProviderAdapter({
                apiKey: 'fixture-key',
                apiEndpoint: 'https://fixture.invalid/v1',
            });
            const metadata = snapshot.models[`minimax/${model}`];
            const input = {
                model,
                supportsReasoning: true,
                reasoningOptions: normalizeReasoningOptions(metadata.reasoning_options),
            };
            expect(provider.getReasoningLevels(input)).toEqual([]);
            const body = await sentBody(provider, {
                ...input,
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel: 'medium',
            });
            expect(body.reasoning_effort).toBeUndefined();
            expect(body.output_config?.effort).toBeUndefined();
        }
    );

    it('user opening a toggle-only Qwen template sees no fictitious depths and retains enabled thinking on send', async () => {
        const provider = new OpenAICompatibleProviderAdapter({
            apiEndpoint: 'https://fixture.invalid/v1',
            config: { reasoning: { format: 'qwen-chat-template' } },
        });
        const input = {
            model: 'qwen3-32b',
            supportsReasoning: true,
            reasoningOptions: [{ type: 'toggle' as const }],
        };
        expect(provider.getReasoningLevels(input)).toEqual([]);
        const body = await sentBody(provider, {
            ...input,
            messages: [{ role: 'user', content: 'hello' }],
        });
        expect(body.chat_template_kwargs).toEqual({
            enable_thinking: true,
            preserve_thinking: true,
        });
    });

    it('user choosing Claude effort through a compatible provider sends the selected effort', async () => {
        const provider = new AnthropicCompatibleProviderAdapter({
            apiKey: 'fixture-key',
            apiEndpoint: 'https://fixture.invalid/v1',
        });
        const metadata = snapshot.models['anthropic/claude-opus-5-5'];
        const input = {
            model: metadata.id,
            supportsReasoning: true,
            reasoningOptions: normalizeReasoningOptions(metadata.reasoning_options),
        };
        for (const level of provider.getReasoningLevels(input)) {
            const body = await sentBody(provider, {
                ...input,
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel: level,
            });
            expect(body.output_config?.effort).toBe(level);
            expect(body.thinking.type).toBe('adaptive');
        }
    });

    it('user using a Kimi K3 relay sees only supported efforts and sends every offered choice', async () => {
        const provider = new MoonshotProviderAdapter({
            apiKey: 'fixture-key',
            apiEndpoint: 'https://fixture.invalid/v1',
            config: { reasoning: { mode: 'passthrough' } },
        });
        const input = { model: 'kimi-k3', supportsReasoning: true };
        const levels = provider.getReasoningLevels(input);
        expect(levels).toEqual(['low', 'high', 'max']);
        for (const level of levels) {
            const body = await sentBody(provider, {
                ...input,
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel: level,
            });
            expect(body.reasoning_effort).toBe(level);
        }
    });

    it.each(['kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'moonshot-v1-32k'])(
        'user using %s does not see depth controls that the SDK would discard',
        (model) => {
            const provider = new MoonshotProviderAdapter({
                apiEndpoint: 'https://fixture.invalid/v1',
            });
            expect(
                provider.getReasoningLevels({
                    model,
                    supportsReasoning: true,
                    reasoningOptions: [{ type: 'toggle' }],
                })
            ).toEqual([]);
        }
    );

    it('user using an xAI relay can send every offered SDK effort', async () => {
        const provider = new XaiProviderAdapter({
            apiKey: 'fixture-key',
            apiEndpoint: 'https://fixture.invalid/v1',
            config: { reasoning: { mode: 'passthrough' } },
        });
        const input = { model: 'custom-relay-model', supportsReasoning: true };
        const levels = provider.getReasoningLevels(input);
        expect(levels).toEqual(['low', 'medium', 'high', 'xhigh']);
        for (const level of levels) {
            const body = await sentBody(provider, {
                ...input,
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel: level,
            });
            expect(body.reasoning_effort).toBe(level);
        }
    });

    it('user choosing a GLM effort sends the provider native field in the actual request', async () => {
        const provider = new ZhipuProviderAdapter({
            apiKey: 'fixture-key',
            apiEndpoint: 'https://fixture.invalid/v1',
        });
        const metadata = snapshot.models['zhipuai/glm-5.3'];
        const input = {
            model: metadata.id,
            supportsReasoning: true,
            reasoningOptions: normalizeReasoningOptions(metadata.reasoning_options),
        };
        expect(provider.getReasoningLevels(input)).toEqual(['low', 'high', 'max']);
        for (const level of provider.getReasoningLevels(input)) {
            const body = await sentBody(provider, {
                ...input,
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel: level,
            });
            expect(body.reasoning_effort).toBe(level);
            expect(body.reasoningEffort).toBeUndefined();
        }
        expect(
            provider.getReasoningLevels({ ...input, reasoningOptions: [{ type: 'toggle' }] })
        ).toEqual([]);
        const toggleBody = await sentBody(provider, {
            model: 'glm-4.7',
            supportsReasoning: true,
            reasoningOptions: [{ type: 'toggle' }],
            messages: [{ role: 'user', content: 'hello' }],
        });
        expect(toggleBody.thinking).toEqual({ type: 'enabled' });
        expect(toggleBody.reasoning_effort).toBeUndefined();
    });

    it('user selecting any depth for a toggle-only DeepSeek model sends a supported request', async () => {
        const provider = new DeepSeekProviderAdapter({
            apiKey: 'fixture-key',
            apiEndpoint: 'https://fixture.invalid/v1',
        });
        const metadata = snapshot.models['deepseek/deepseek-v3.1-terminus'];
        const input = {
            model: metadata.id,
            supportsReasoning: metadata.reasoning,
            reasoningOptions: normalizeReasoningOptions(metadata.reasoning_options),
        };
        const levels = provider.getReasoningLevels(input);
        expect(levels).toEqual(['off', 'low', 'high', 'max']);
        for (const level of levels) {
            fetchMock.mockReset();
            fetchMock.mockResolvedValueOnce(
                new Response(JSON.stringify({ error: { message: 'fixture rejection' } }), {
                    status: 400,
                })
            );
            await expect(
                provider.request({
                    ...input,
                    messages: [{ role: 'user', content: 'hello' }],
                    reasoningLevel: level,
                })
            ).rejects.toThrow('fixture rejection');
            expect(fetchMock).toHaveBeenCalledOnce();
            const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
            expect(body.thinking).toEqual({ type: level === 'off' ? 'disabled' : 'enabled' });
            expect(body.reasoning_effort).toBe(level === 'off' ? undefined : level);
        }
    });

    it.each(['claude-opus-5-5', 'claude-opus-4-6', 'claude-opus-4-5'] as const)(
        'user choosing lower and higher efforts on %s sends each selected effort',
        async (model) => {
            const provider = new AnthropicProviderAdapter({
                apiKey: 'fixture-key',
                apiEndpoint: 'https://fixture.invalid/v1',
            });
            const metadata = snapshot.models[`anthropic/${model}`];
            const input = {
                model,
                supportsReasoning: metadata.reasoning,
                reasoningOptions: normalizeReasoningOptions(metadata.reasoning_options),
            };
            const selectedLevels =
                model === 'claude-opus-4-5'
                    ? (['low', 'high'] as const)
                    : (['low', 'max'] as const);
            for (const level of selectedLevels) {
                expect(provider.getReasoningLevels(input)).toContain(level);
                fetchMock.mockReset();
                fetchMock.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            type: 'error',
                            error: { type: 'invalid_request_error', message: 'fixture rejection' },
                        }),
                        { status: 400 }
                    )
                );
                await expect(
                    provider.request({
                        ...input,
                        messages: [{ role: 'user', content: 'hello' }],
                        reasoningLevel: level,
                    })
                ).rejects.toThrow('fixture rejection');
                expect(fetchMock).toHaveBeenCalledOnce();
                const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
                expect(body.output_config?.effort).toBe(level);
                expect(body.thinking.type).toBe(
                    model === 'claude-opus-4-5' ? 'enabled' : 'adaptive'
                );
            }
        }
    );

    it('user with incomplete toggle metadata for an always-adaptive model can only select encodable efforts', async () => {
        const provider = new AnthropicProviderAdapter({
            apiKey: 'fixture-key',
            apiEndpoint: 'https://fixture.invalid/v1',
        });
        const input = {
            model: 'claude-opus-5-5',
            supportsReasoning: true,
            reasoningOptions: [{ type: 'toggle' as const }],
        };
        const levels = provider.getReasoningLevels(input);
        expect(levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
        for (const level of levels) {
            fetchMock.mockReset();
            fetchMock.mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        type: 'error',
                        error: { type: 'invalid_request_error', message: 'fixture rejection' },
                    }),
                    { status: 400 }
                )
            );
            await expect(
                provider.request({
                    ...input,
                    messages: [{ role: 'user', content: 'hello' }],
                    reasoningLevel: level,
                })
            ).rejects.toThrow('fixture rejection');
            const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
            expect(body.output_config.effort).toBe(level);
            expect(body.thinking.type).toBe('adaptive');
        }
    });

    it('user choosing a depth on an older Claude model retains distinct token budgets', async () => {
        const provider = new AnthropicProviderAdapter({
            apiKey: 'fixture-key',
            apiEndpoint: 'https://fixture.invalid/v1',
        });
        for (const [level, budget] of [
            ['low', 2048],
            ['high', 16384],
        ] as const) {
            fetchMock.mockReset();
            fetchMock.mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        type: 'error',
                        error: { type: 'invalid_request_error', message: 'fixture rejection' },
                    }),
                    { status: 400 }
                )
            );
            await expect(
                provider.request({
                    model: 'claude-3-7-sonnet-20250219',
                    supportsReasoning: true,
                    reasoningOptions: [{ type: 'budget_tokens' }],
                    messages: [{ role: 'user', content: 'hello' }],
                    reasoningLevel: level,
                })
            ).rejects.toThrow('fixture rejection');
            const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
            expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: budget });
            expect(body.output_config?.effort).toBeUndefined();
        }
    });

    it('user choosing a depth for an OpenAI Chat relay sees only efforts that reach the actual SDK transport', async () => {
        const provider = new OpenAIProviderAdapter({
            apiEndpoint: 'https://relay.example/v1',
            config: { reasoning: { format: 'openai', mode: 'passthrough' } },
        });
        const input = { model: 'custom-relay-model', supportsReasoning: true };
        const levels = provider.getReasoningLevels(input);
        expect(levels).toContain('max');
        expect(levels).not.toContain('ultra');
        for (const level of levels) {
            fetchMock.mockClear();
            fetchMock.mockResolvedValueOnce(
                new Response(JSON.stringify({ error: { message: 'fixture rejection' } }), {
                    status: 400,
                })
            );
            await expect(
                provider.request({
                    ...input,
                    messages: [{ role: 'user', content: 'hello' }],
                    reasoningLevel: level,
                })
            ).rejects.toThrow('fixture rejection');
            expect(fetchMock).toHaveBeenCalledOnce();
            expect(JSON.parse(fetchMock.mock.calls[0]![1].body).reasoning_effort).toBe(level);
        }
        const metadata = {
            ...input,
            reasoningOptions: [{ type: 'effort' as const, values: ['off', 'max', 'ultra'] }],
        };
        expect(provider.getReasoningLevels(metadata)).toEqual(['max']);
    });

    it.each(['responses', 'compatible'] as const)(
        'user choosing Ultra through %s can still send it using that SDK transport',
        async (transport) => {
            const config = {
                apiEndpoint: 'https://relay.example/v1',
                config: { reasoning: { mode: 'passthrough' as const } },
            };
            const provider =
                transport === 'responses'
                    ? new OpenAIProviderAdapter(config)
                    : new OpenAICompatibleProviderAdapter(config);
            const input = { model: 'custom-relay-model', supportsReasoning: true };
            expect(provider.getReasoningLevels(input)).toContain('ultra');
            fetchMock.mockClear();
            fetchMock.mockResolvedValueOnce(
                new Response(JSON.stringify({ error: { message: 'fixture rejection' } }), {
                    status: 400,
                })
            );
            await expect(
                provider.request({
                    ...input,
                    messages: [{ role: 'user', content: 'hello' }],
                    reasoningLevel: 'ultra',
                })
            ).rejects.toThrow('fixture rejection');
            expect(fetchMock).toHaveBeenCalledOnce();
            const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
            expect(transport === 'responses' ? body.reasoning.effort : body.reasoning_effort).toBe(
                'ultra'
            );
        }
    );

    it.each(['gpt-6-sol-pro', 'gpt-6-luna-pro'] as const)(
        'user with %s metadata cannot choose Off when the OpenAI SDK cannot send it',
        async (model) => {
            const metadata = snapshot.models[`openai/${model}`];
            for (const format of ['openai-responses', 'openai'] as const) {
                for (const hasTools of [false, true]) {
                    const provider = new OpenAIProviderAdapter({
                        apiEndpoint: 'https://fixture.invalid/v1',
                        config: { reasoning: { format } },
                    });
                    const input = {
                        model,
                        supportsReasoning: true,
                        hasTools,
                        reasoningOptions: normalizeReasoningOptions(metadata.reasoning_options),
                    };
                    const levels = provider.getReasoningLevels(input);
                    expect(levels).not.toContain('off');
                    if (format === 'openai' && hasTools) expect(levels).toEqual([]);
                }
            }
        }
    );
    it('user with a prefixed custom GPU model still sees every supported relay effort', () => {
        const provider = new OpenAIProviderAdapter({
            apiEndpoint: 'https://relay.example/v1',
            config: { reasoning: { mode: 'passthrough' } },
        });
        expect(
            provider.getReasoningLevels({
                model: 'relay/gpt-6-sol-pro',
                supportsReasoning: true,
                reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'high', 'ultra'] }],
            })
        ).toEqual(['off', 'low', 'high', 'ultra']);
    });
    it('user with a GPT-6 Sol suffix sees only efforts the SDK keeps on the wire', async () => {
        const provider = new OpenAIProviderAdapter({
            apiEndpoint: 'https://relay.example/v1',
            config: { reasoning: { mode: 'passthrough' } },
        });
        const input = {
            model: 'gpt-6-sol/relay',
            supportsReasoning: true,
            reasoningOptions: [
                { type: 'effort' as const, values: ['none', 'low', 'high', 'ultra'] },
            ],
        };
        expect(provider.getReasoningLevels(input)).toEqual(['low', 'high']);
        for (const reasoningLevel of ['low', 'high'] as const) {
            const body = await sentBody(provider, {
                ...input,
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel,
            });
            expect(body.reasoning.effort).toBe(reasoningLevel);
        }
    });
    it('user with a GPT-6 chat alias sees only depths the SDK keeps on the wire', async () => {
        const provider = new OpenAIProviderAdapter({
            apiEndpoint: 'https://relay.example/v1',
            config: { reasoning: { mode: 'passthrough' } },
        });
        const input = { model: 'gpt-6-chat-latest', supportsReasoning: true };
        expect(provider.getReasoningLevels(input)).toEqual([
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
        ]);
        for (const reasoningLevel of ['low', 'max'] as const) {
            const body = await sentBody(provider, {
                ...input,
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel,
            });
            expect(body.reasoning.effort).toBe(reasoningLevel);
        }
    });
    it.each(['gpt-6', 'gpt-6-sol-pro', 'gpt-6-luna-pro'] as const)(
        'user with toggle-only %s metadata cannot choose Off when the SDK would drop it',
        async (model) => {
            const provider = new OpenAIProviderAdapter({
                apiEndpoint: 'https://relay.example/v1',
                config: { reasoning: { mode: 'passthrough' } },
            });
            const input = {
                model,
                supportsReasoning: true,
                reasoningOptions: [{ type: 'toggle' as const }],
            };
            expect(provider.getReasoningLevels(input)).not.toContain('off');
        }
    );
    it.each(['gpt-6-sol', 'gpt-6-luna'] as const)(
        'user with toggle-only %s metadata can still disable reasoning on the wire',
        async (model) => {
            const provider = new OpenAIProviderAdapter({
                apiEndpoint: 'https://relay.example/v1',
                config: { reasoning: { mode: 'passthrough' } },
            });
            const input = {
                model,
                supportsReasoning: true,
                reasoningOptions: [{ type: 'toggle' as const }],
            };
            expect(provider.getReasoningLevels(input)).toContain('off');
            const body = await sentBody(provider, {
                ...input,
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel: 'off',
            });
            expect(body.reasoning).toEqual({ effort: 'none' });
        }
    );
    it('user selects Off for a custom Responses model and the serialized request disables reasoning', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ error: { message: 'fixture rejection' } }), {
                status: 400,
            })
        );
        const provider = new OpenAIProviderAdapter({
            apiEndpoint: 'https://relay.example/v1',
            config: { reasoning: { mode: 'passthrough' } },
        });
        expect(
            provider.getReasoningLevels({ model: 'custom-relay-model', supportsReasoning: true })
        ).toContain('off');
        await expect(
            provider.request({
                model: 'custom-relay-model',
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel: 'off',
            })
        ).rejects.toThrow('fixture rejection');
        const body = JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]![1].body);
        expect(body.reasoning).toEqual({ effort: 'none' });
        expect(body.store).toBe(false);
    });
    it('user cannot select Off for a passthrough relay unless its outgoing payload can disable reasoning', () => {
        const provider = new RequestProbe({
            apiEndpoint: 'https://relay.example/v1',
            config: { reasoning: { mode: 'passthrough' } },
        });
        const input = { model: 'custom', supportsReasoning: true };
        expect(provider.getReasoningLevels(input)).not.toContain('off');
        const supported = {
            ...input,
            reasoningOptions: [{ type: 'effort' as const, values: ['none', 'low', 'high'] }],
        };
        expect(provider.getReasoningLevels(supported)).toContain('off');
        expect(
            provider.outgoing({
                ...supported,
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel: 'off',
            })
        ).toEqual({
            openaiCompatible: { reasoningEffort: 'none' },
        });
    });

    it('user selects Off for a passthrough thinking protocol and the request explicitly disables it', () => {
        const provider = new RequestProbe({
            apiEndpoint: 'https://relay.example/v1',
            config: { reasoning: { mode: 'passthrough', format: 'deepseek' } },
        });
        const input = { model: 'custom', supportsReasoning: true };
        expect(provider.getReasoningLevels(input)).toContain('off');
        expect(
            provider.outgoing({
                ...input,
                messages: [{ role: 'user', content: 'hello' }],
                reasoningLevel: 'off',
            })
        ).toEqual({
            openaiCompatible: { thinking: { type: 'disabled' } },
        });
    });

    it('user sees the same supported depths as the official model request when metadata is missing', () => {
        const provider = new OpenAIProviderAdapter({ apiEndpoint: 'https://api.openai.com/v1' });
        expect(provider.getReasoningLevels({ model: 'gpt-6', supportsReasoning: true })).toEqual([
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
        ]);
        expect(provider.getReasoningLevels({ model: 'gpt-4o', supportsReasoning: false })).toEqual(
            []
        );
    });

    it('user sees metadata restrict the choices instead of inventing unsupported depths', () => {
        const provider = new OpenAICompatibleProviderAdapter({
            apiEndpoint: 'https://relay.example/v1',
        });
        expect(
            provider.getReasoningLevels({
                model: 'custom',
                supportsReasoning: true,
                reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'high'] }],
            })
        ).toEqual(['off', 'low', 'high']);
    });

    it('user cannot change reasoning when the provider disables it', () => {
        const provider = new OpenAIProviderAdapter({
            apiEndpoint: 'https://api.openai.com/v1',
            config: { reasoning: { mode: 'off' } },
        });
        expect(provider.getReasoningLevels({ model: 'gpt-6', supportsReasoning: true })).toEqual(
            []
        );
    });

    it('user can set a relay depth only when passthrough is explicitly configured', () => {
        const provider = new OpenAICompatibleProviderAdapter({
            apiEndpoint: 'https://relay.example/v1',
            config: { reasoning: { mode: 'passthrough' } },
        });
        expect(
            provider.getReasoningLevels({ model: 'custom', supportsReasoning: false })
        ).toContain('ultra');
        const automatic = new OpenAICompatibleProviderAdapter({
            apiEndpoint: 'https://relay.example/v1',
        });
        expect(automatic.getReasoningLevels({ model: 'custom', supportsReasoning: true })).toEqual(
            []
        );
    });
});
