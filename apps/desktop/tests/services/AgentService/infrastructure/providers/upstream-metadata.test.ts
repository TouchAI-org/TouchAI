import { describe, expect, it } from 'vitest';

import type { ModelInfo } from '@/services/AgentService/infrastructure/providers';
import { OpenAICompatibleProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/openai-compatible';
import { normalizeUpstreamModelMetadata } from '@/services/AgentService/infrastructure/providers/upstreamMetadata';

/** 取自 Magpie 网关 `/v1/models` 的真实形态。 */
function magpieModel(overrides: Record<string, unknown> = {}) {
    return {
        id: 'group/auto-deepseek-v4-1-flash',
        object: 'model',
        type: 'model',
        created: 0,
        created_at: '2025-01-01T00:00:00Z',
        display_name: 'DeepSeek V4.1 Flash',
        owned_by: 'opencode-zen',
        magpie_label: 'DeepSeek V4.1 Flash · routing group',
        context_length: 200_000,
        context_window: 200_000,
        max_input_tokens: 200_000,
        max_output_tokens: 200_000,
        modalities: { input: ['text', 'image'] },
        reasoning: true,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }],
        native_endpoints: ['/v1/responses'],
        ...overrides,
    };
}

describe('upstream model metadata', () => {
    it('maps gateway fields onto the model capability columns', () => {
        expect(normalizeUpstreamModelMetadata(magpieModel())).toEqual({
            context_limit: 200_000,
            output_limit: 200_000,
            modalities: JSON.stringify({ input: ['text', 'image'], output: ['text'] }),
            reasoning: 1,
            reasoning_options: JSON.stringify([{ type: 'effort', values: ['low', 'high', 'max'] }]),
        });
    });

    it('clamps the gateway-only ultra effort onto max', () => {
        const metadata = normalizeUpstreamModelMetadata(
            magpieModel({
                reasoning: true,
                supported_reasoning_levels: [
                    { effort: 'none' },
                    { effort: 'low' },
                    { effort: 'medium' },
                    { effort: 'high' },
                    { effort: 'xhigh' },
                    { effort: 'max' },
                    { effort: 'ultra' },
                ],
            })
        );

        expect(metadata?.reasoning_options).toBe(
            JSON.stringify([
                {
                    type: 'effort',
                    values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
                },
            ])
        );
    });

    it('reads OpenRouter style architecture, limits and tool support', () => {
        expect(
            normalizeUpstreamModelMetadata({
                id: 'anthropic/claude-3-5-haiku',
                name: 'Claude 3.5 Haiku',
                context_length: 200_000,
                top_provider: { context_length: 200_000, max_completion_tokens: 8192 },
                architecture: {
                    input_modalities: ['text', 'image', 'file'],
                    output_modalities: ['text'],
                },
                supported_parameters: ['tools', 'tool_choice', 'temperature'],
                reasoning: { supported_efforts: ['low', 'medium', 'high'] },
            })
        ).toEqual({
            context_limit: 200_000,
            output_limit: 8192,
            modalities: JSON.stringify({
                input: ['text', 'image', 'file'],
                output: ['text'],
            }),
            attachment: 1,
            reasoning: 1,
            reasoning_options: JSON.stringify([
                { type: 'effort', values: ['low', 'medium', 'high'] },
            ]),
            tool_call: 1,
        });
    });

    it('keeps TouchAI native reasoning_options from AI gateways', () => {
        expect(
            normalizeUpstreamModelMetadata({
                id: 'openai/gpt-5-mini',
                reasoning_options: [{ type: 'toggle' }],
            })
        ).toEqual({
            reasoning: 1,
            reasoning_options: JSON.stringify([{ type: 'toggle' }]),
        });
    });

    it('reports models without capability fields as unknown', () => {
        expect(
            normalizeUpstreamModelMetadata({ id: 'plain-model', object: 'model' })
        ).toBeUndefined();
        expect(normalizeUpstreamModelMetadata('plain-model')).toBeUndefined();
    });

    it('honours an explicit reasoning=false declaration', () => {
        expect(
            normalizeUpstreamModelMetadata({
                id: 'any/claude-3-5-haiku-20241022',
                reasoning: false,
            })
        ).toEqual({ reasoning: 0 });
    });
});

describe('openai-compatible model list parsing', () => {
    function parse(payload: unknown): ModelInfo[] {
        const adapter = new OpenAICompatibleProviderAdapter({
            apiEndpoint: 'http://127.0.0.1:3425/v1',
        });
        const probe = adapter as unknown as { parseModelList(payload: unknown): ModelInfo[] };
        return probe.parseModelList(payload);
    }

    it('keeps the capability fields the gateway returns', () => {
        const models = parse({
            object: 'list',
            data: [magpieModel(), { id: 'qianai/deepseek-v4.1-flash-0910', object: 'model' }],
        });

        expect(models).toHaveLength(2);
        expect(models[0]).toEqual({
            id: 'group/auto-deepseek-v4-1-flash',
            name: 'group/auto-deepseek-v4-1-flash',
            metadata: {
                context_limit: 200_000,
                output_limit: 200_000,
                modalities: JSON.stringify({ input: ['text', 'image'], output: ['text'] }),
                reasoning: 1,
                reasoning_options: JSON.stringify([
                    { type: 'effort', values: ['low', 'high', 'max'] },
                ]),
            },
        });
        expect(models[1]).toEqual({
            id: 'qianai/deepseek-v4.1-flash-0910',
            name: 'qianai/deepseek-v4.1-flash-0910',
        });
    });
});
