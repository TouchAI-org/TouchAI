// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiStreamChunk } from '@/services/AgentService/contracts/protocol';
import { OpenAICompatibleProviderAdapter } from '@/services/AgentService/infrastructure/providers/adapters/openai-compatible';

const { httpFetch } = vi.hoisted(() => ({ httpFetch: vi.fn() }));

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));

function response(usage: unknown): Response {
    const chunks = [
        { choices: [{ index: 0, delta: { content: 'Answer' }, finish_reason: null }] },
        {
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            ...(usage === undefined ? {} : { usage }),
        },
    ];
    const bytes = new TextEncoder().encode(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    );
    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                // Split across SSE/JSON boundaries, as a real HTTP body can.
                controller.enqueue(bytes.slice(0, 17));
                controller.enqueue(bytes.slice(17));
                controller.close();
            },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
    );
}

async function answer(usage: unknown): Promise<AiStreamChunk[]> {
    httpFetch.mockResolvedValueOnce(response(usage));
    const adapter = new OpenAICompatibleProviderAdapter({
        apiEndpoint: 'https://controlled.test/v1',
        apiKey: 'controlled-key',
    });
    const chunks: AiStreamChunk[] = [];
    for await (const chunk of adapter.stream({
        model: 'controlled-model',
        messages: [{ role: 'user', content: 'controlled-prompt' }],
    })) {
        chunks.push(chunk);
    }
    return chunks;
}

function lastChunk(chunks: AiStreamChunk[]): AiStreamChunk | undefined {
    return chunks[chunks.length - 1];
}

describe('given a compatible provider sends usage through the installed SDK', () => {
    beforeEach(() => {
        httpFetch.mockReset();
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => vi.restoreAllMocks());

    it.each([
        ['missing usage', undefined],
        ['an empty usage envelope', {}],
        ['a null usage envelope', null],
        [
            'null token fields',
            {
                prompt_tokens: null,
                completion_tokens: null,
                prompt_tokens_details: { cached_tokens: null },
                completion_tokens_details: { reasoning_tokens: null },
            },
        ],
        ['only a total token count', { total_tokens: 12 }],
    ])('user gets no observed usage when the provider sends %s', async (_label, usage) => {
        const chunks = await answer(usage);

        expect(chunks.map((chunk) => chunk.content).join('')).toBe('Answer');
        expect(chunks.filter((chunk) => chunk.done)).toHaveLength(1);
        expect(lastChunk(chunks)).toMatchObject({ done: true, usageReported: false });
    });

    it.each([
        ['explicit zero', { prompt_tokens: 0, completion_tokens: 0 }, 0, 0],
        ['input only', { prompt_tokens: 12 }, 12, 0],
        ['output only', { completion_tokens: 7 }, 0, 7],
        ['both token counts', { prompt_tokens: 12, completion_tokens: 7 }, 12, 7],
        ['cache only', { prompt_tokens_details: { cached_tokens: 3 } }, 0, 0],
    ])(
        'user gets observed usage when the provider sends %s',
        async (_label, usage, inputTokens, outputTokens) => {
            const chunks = await answer(usage);

            expect(lastChunk(chunks)).toMatchObject({
                done: true,
                usageReported: true,
                usage: { inputTokens, outputTokens },
            });
        }
    );

    it('user gets independent evidence when an empty report follows an explicit zero report', async () => {
        const reported = await answer({ prompt_tokens: 0 });
        const missing = await answer({});

        expect(lastChunk(reported)?.usageReported).toBe(true);
        expect(lastChunk(missing)?.usageReported).toBe(false);
    });
});
