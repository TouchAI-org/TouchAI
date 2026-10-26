import type { TextStreamPart, ToolSet } from 'ai';
import { describe, expect, it } from 'vitest';

import {
    createAiSdkStreamProcessor,
    normalizeAiUsage,
} from '@/services/AgentService/infrastructure/providers/ai-sdk/stream';

/**
 * The stream processor is the seam between a provider's raw event stream and the app's chunk
 * protocol. What a user observes is: the answer text arriving, the tool call arriving with the
 * arguments the model actually produced, and the token usage reported at the end.
 *
 * These cover the paths a real provider hits that the happy-path tests do not: a provider that
 * sends its arguments as a string, one that sends a bare final snapshot, one that omits the
 * finish reason, and the accounting fields a usage report may or may not carry.
 */

type TestStreamPart = TextStreamPart<ToolSet>;

function toolInputStart(id: string, toolName: string, extra: Record<string, unknown> = {}) {
    return { type: 'tool-input-start', id, toolName, ...extra } as TestStreamPart;
}

function toolInputDelta(id: string, delta: string): TestStreamPart {
    return { type: 'tool-input-delta', id, delta } as TestStreamPart;
}

function toolCall(
    toolCallId: string,
    toolName: string,
    input: unknown,
    extra: Record<string, unknown> = {}
): TestStreamPart {
    return {
        type: 'tool-call',
        toolCallId,
        toolName,
        input,
        dynamic: true,
        ...extra,
    } as TestStreamPart;
}

describe('user sees the answer text stream through', () => {
    it('user sees each text delta as the answer grows', () => {
        const processor = createAiSdkStreamProcessor();

        expect(
            processor.consumePart({ type: 'text-delta', id: 't1', text: 'Hel' } as TestStreamPart)
        ).toEqual([{ content: 'Hel', done: false }]);
        expect(
            processor.consumePart({ type: 'text-delta', id: 't1', text: 'lo' } as TestStreamPart)
        ).toEqual([{ content: 'lo', done: false }]);
    });

    it('user sees an empty text delta forwarded without breaking the answer', () => {
        const processor = createAiSdkStreamProcessor();

        expect(
            processor.consumePart({ type: 'text-delta', id: 't1', text: '' } as TestStreamPart)
        ).toEqual([{ content: '', done: false }]);
    });

    it('user does not get a chunk for a stream part the app has no use for', () => {
        const processor = createAiSdkStreamProcessor();

        expect(processor.consumePart({ type: 'start-step' } as TestStreamPart)).toEqual([]);
        expect(processor.consumePart({ type: 'finish-step' } as TestStreamPart)).toEqual([]);
    });
});

describe('user gets the tool arguments the model actually wrote', () => {
    it('user gets arguments a provider sent as a string kept verbatim', () => {
        const processor = createAiSdkStreamProcessor();

        const chunks = processor.consumePart(
            toolCall('call_1', 'builtin__read', '{"filePath":"notes.txt"}')
        );

        expect(chunks[0]?.toolCallDeltas?.[0]).toMatchObject({
            callId: 'call_1',
            name: 'builtin__read',
            argumentsBuffer: '{"filePath":"notes.txt"}',
            isComplete: true,
        });
    });

    it('user gets an object argument serialised into the buffer the executor parses', () => {
        const processor = createAiSdkStreamProcessor();

        const chunks = processor.consumePart(
            toolCall('call_1', 'builtin__read', { filePath: 'notes.txt' })
        );

        expect(chunks[0]?.toolCallDeltas?.[0]?.argumentsBuffer).toBe('{"filePath":"notes.txt"}');
    });

    it('user gets an empty argument object sent as an empty object literal', () => {
        const processor = createAiSdkStreamProcessor();

        const chunks = processor.consumePart(toolCall('call_1', 'builtin__glob', {}));

        expect(chunks[0]?.toolCallDeltas?.[0]?.argumentsBuffer).toBe('{}');
    });

    it('user gets a null argument object sent as parseable JSON', () => {
        const processor = createAiSdkStreamProcessor();

        const chunks = processor.consumePart(toolCall('call_1', 'builtin__glob', null));

        // Whatever the provider sends, the executor must be able to parse the buffer.
        expect(() => JSON.parse(chunks[0]!.toolCallDeltas![0]!.argumentsBuffer!)).not.toThrow();
    });

    it('user gets an empty array argument sent as an empty array', () => {
        const processor = createAiSdkStreamProcessor();

        const chunks = processor.consumePart(toolCall('call_1', 'builtin__glob', []));

        expect(chunks[0]?.toolCallDeltas?.[0]?.argumentsBuffer).toBe('[]');
    });

    it('user gets a circular argument replaced by an empty object instead of crashing the stream', () => {
        const processor = createAiSdkStreamProcessor();
        const circular: Record<string, unknown> = { name: 'loop' };
        circular.self = circular;

        const chunks = processor.consumePart(toolCall('call_1', 'builtin__glob', circular));

        expect(chunks[0]?.toolCallDeltas?.[0]?.argumentsBuffer).toBe('{}');
    });

    it('user gets the streamed arguments preferred over a bare final snapshot', () => {
        // Some providers repeat the call at the end with an empty input; the real arguments only
        // ever appeared in the deltas.
        const processor = createAiSdkStreamProcessor();

        processor.consumePart(toolInputStart('call_1', 'builtin__read'));
        processor.consumePart(toolInputDelta('call_1', '{"filePath":"notes.txt"}'));

        const chunks = processor.consumePart(toolCall('call_1', '', {}));

        expect(chunks[0]?.toolCallDeltas?.[0]?.argumentsBuffer).toBe('{"filePath":"notes.txt"}');
    });

    it('user gets the final snapshot used when the streamed buffer was not valid JSON', () => {
        const processor = createAiSdkStreamProcessor();

        processor.consumePart(toolInputStart('call_1', 'builtin__read'));
        processor.consumePart(toolInputDelta('call_1', '{"filePath":'));

        const chunks = processor.consumePart(
            toolCall('call_1', 'builtin__read', { filePath: 'from-snapshot.txt' })
        );

        expect(chunks[0]?.toolCallDeltas?.[0]?.argumentsBuffer).toBe(
            '{"filePath":"from-snapshot.txt"}'
        );
    });

    it('user gets the final snapshot used when the stream never sent any arguments', () => {
        const processor = createAiSdkStreamProcessor();

        processor.consumePart(toolInputStart('call_1', 'builtin__read'));

        const chunks = processor.consumePart(
            toolCall('call_1', 'builtin__read', { filePath: 'notes.txt' })
        );

        expect(chunks[0]?.toolCallDeltas?.[0]?.argumentsBuffer).toBe('{"filePath":"notes.txt"}');
    });
});

describe('user does not get a broken tool call when the stream is incomplete', () => {
    it('user gets no tool call start when the provider sent no tool name', () => {
        const processor = createAiSdkStreamProcessor();

        expect(processor.consumePart(toolInputStart('call_1', '   '))).toEqual([]);
    });

    it('user gets no argument delta when no tool call ever started for that id', () => {
        const processor = createAiSdkStreamProcessor();

        expect(processor.consumePart(toolInputDelta('unknown-call', '{"a":1}'))).toEqual([]);
    });

    it('user gets the streamed deltas for one call kept apart from another', () => {
        const processor = createAiSdkStreamProcessor();

        processor.consumePart(toolInputStart('call_1', 'builtin__read'));
        processor.consumePart(toolInputDelta('call_1', '{"filePath":"a.txt"}'));
        processor.consumePart(toolInputStart('call_2', 'builtin__glob'));
        processor.consumePart(toolInputDelta('call_2', '{"pattern":"*.ts"}'));

        const first = processor.consumePart(toolCall('call_1', 'builtin__read', {}));
        const second = processor.consumePart(toolCall('call_2', 'builtin__glob', {}));

        expect(first[0]?.toolCallDeltas?.[0]?.argumentsBuffer).toBe('{"filePath":"a.txt"}');
        expect(second[0]?.toolCallDeltas?.[0]?.argumentsBuffer).toBe('{"pattern":"*.ts"}');
    });

    it('user gets the tool calls numbered in the order they started', () => {
        const processor = createAiSdkStreamProcessor();

        processor.consumePart(toolInputStart('call_a', 'builtin__read'));
        processor.consumePart(toolInputStart('call_b', 'builtin__glob'));
        processor.consumePart(toolInputStart('call_c', 'builtin__write'));

        const a = processor.consumePart(toolCall('call_a', 'builtin__read', {}));
        const b = processor.consumePart(toolCall('call_b', 'builtin__glob', {}));
        const c = processor.consumePart(toolCall('call_c', 'builtin__write', {}));

        expect(a[0]?.toolCallDeltas?.[0]?.index).toBe(0);
        expect(b[0]?.toolCallDeltas?.[0]?.index).toBe(1);
        expect(c[0]?.toolCallDeltas?.[0]?.index).toBe(2);
    });
});

describe('user is told when a tool call was interrupted', () => {
    it('user gets a tool call backfilled when the provider never sent its final event', () => {
        // The model asked for a tool and the stream ended on `tool-calls` without the final
        // event; dropping the call would silently swallow the model's request.
        const processor = createAiSdkStreamProcessor();

        processor.consumePart(toolInputStart('call_1', 'builtin__read'));
        processor.consumePart(toolInputDelta('call_1', '{"filePath":"notes.txt"}'));

        const finish = processor.buildFinishChunk('tool-calls');

        expect(finish.toolCalls).toEqual([
            expect.objectContaining({
                id: 'call_1',
                name: 'builtin__read',
                arguments: '{"filePath":"notes.txt"}',
            }),
        ]);
        expect(finish.finishReason).toBe('tool_calls');
    });

    it('user gets an interrupted call with no arguments backfilled with an empty object', () => {
        const processor = createAiSdkStreamProcessor();

        processor.consumePart(toolInputStart('call_1', 'builtin__read'));
        processor.consumePart(toolInputDelta('call_1', '  '));

        const finish = processor.buildFinishChunk('tool-calls');

        expect(finish.toolCalls).toEqual([
            expect.objectContaining({ id: 'call_1', arguments: '{}' }),
        ]);
    });

    it('user does not get an interrupted call backfilled when the stream ended normally', () => {
        const processor = createAiSdkStreamProcessor();

        processor.consumePart(toolInputStart('call_1', 'builtin__read'));

        const finish = processor.buildFinishChunk('stop');

        expect(finish.toolCalls).toBeUndefined();
        expect(finish.finishReason).toBe('stop');
    });

    it('user gets the tool-call finish reason even when no call survived', () => {
        const processor = createAiSdkStreamProcessor();

        const finish = processor.buildFinishChunk('tool-calls');

        expect(finish.finishReason).toBe('tool_calls');
        expect(finish.toolCalls).toBeUndefined();
    });

    it('user gets a normal stop reported as stop', () => {
        const processor = createAiSdkStreamProcessor();

        expect(processor.buildFinishChunk('stop').finishReason).toBe('stop');
    });

    it('user gets a length-limited answer reported as length', () => {
        const processor = createAiSdkStreamProcessor();

        expect(processor.buildFinishChunk('length').finishReason).toBe('length');
    });

    it('user gets a missing finish reason treated as a normal stop', () => {
        const processor = createAiSdkStreamProcessor();

        expect(processor.buildFinishChunk(undefined).finishReason).toBe('stop');
    });
});

describe('user gets a provider error raised instead of a silent empty answer', () => {
    it('user gets the provider error thrown as it arrived', () => {
        const processor = createAiSdkStreamProcessor();
        const failure = new Error('upstream exploded');

        expect(() =>
            processor.consumePart({ type: 'error', error: failure } as TestStreamPart)
        ).toThrow(failure);
    });

    it('user gets a non-error failure thrown as readable text', () => {
        const processor = createAiSdkStreamProcessor();

        expect(() =>
            processor.consumePart({ type: 'error', error: 'gateway down' } as TestStreamPart)
        ).toThrow('gateway down');
    });
});

describe('user is told what a request cost', () => {
    it('user gets no usage reported when the provider sent none', () => {
        expect(normalizeAiUsage(undefined)).toBeUndefined();
    });

    it('user gets the token counts the provider reported', () => {
        expect(
            normalizeAiUsage({
                inputTokens: 100,
                outputTokens: 20,
                inputTokenDetails: { noCacheTokens: 80, cacheReadTokens: 15, cacheWriteTokens: 5 },
                outputTokenDetails: { reasoningTokens: 7 },
            } as never)
        ).toEqual({
            inputTokens: 80,
            outputTokens: 20,
            cacheReadTokens: 15,
            cacheWriteTokens: 5,
            reasoningTokens: 7,
            servedModel: undefined,
            raw: undefined,
        });
    });

    it('user gets the fresh input counted when the provider only reported a total', () => {
        // No normalised detail, so the cache tokens have to be subtracted from the total.
        expect(
            normalizeAiUsage({
                inputTokens: 100,
                outputTokens: 20,
                inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 10 },
            } as never)
        ).toMatchObject({ inputTokens: 60, cacheReadTokens: 30, cacheWriteTokens: 10 });
    });

    it('user gets the input never reported as negative when a gateway double-counts', () => {
        // Some gateways report prompt_tokens already excluding the cache; subtracting again
        // would report a negative cost.
        expect(
            normalizeAiUsage({
                inputTokens: 10,
                inputTokenDetails: { cacheReadTokens: 50, cacheWriteTokens: 5 },
            } as never)
        ).toMatchObject({ inputTokens: 0 });
    });

    it('user gets zero counts when the provider reported an empty usage object', () => {
        expect(normalizeAiUsage({} as never)).toEqual({
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            servedModel: undefined,
            raw: undefined,
        });
    });

    it('user gets the model that actually served the request named', () => {
        for (const key of ['model', 'model_name', 'modelId', 'model_id']) {
            expect(
                normalizeAiUsage({ raw: { [key]: 'served-model' } } as never)?.servedModel,
                key
            ).toBe('served-model');
        }
    });

    it('user gets no served model when the provider reported a non-string value', () => {
        expect(normalizeAiUsage({ raw: { model: 42 } } as never)?.servedModel).toBeUndefined();
    });

    it('user gets no served model when the provider reported an empty name', () => {
        expect(normalizeAiUsage({ raw: { model: '' } } as never)?.servedModel).toBeUndefined();
    });

    it('user gets the raw usage payload kept for diagnostics', () => {
        const raw = { model: 'gpt-5', total_tokens: 120 };

        expect(normalizeAiUsage({ raw } as never)?.raw).toEqual(raw);
    });

    it('user gets the first recognised model field when several are present', () => {
        expect(
            normalizeAiUsage({
                raw: { model_name: 'second-choice', model: 'first-choice' },
            } as never)?.servedModel
        ).toBe('first-choice');
    });
});

describe('user gets tool metadata carried with the call', () => {
    it('user gets the provider metadata attached to a streamed tool call', () => {
        const processor = createAiSdkStreamProcessor();

        processor.consumePart(
            toolInputStart('call_1', 'builtin__read', {
                providerMetadata: { anthropic: { id: 'toolu_1' } },
            })
        );
        processor.consumePart(toolInputDelta('call_1', '{"filePath":"a.txt"}'));

        const finish = processor.buildFinishChunk('tool-calls');

        expect(finish.toolCalls?.[0]?.providerOptions).toEqual({
            anthropic: { id: 'toolu_1' },
        });
    });

    it('user gets the metadata from the final event preferred over the start event', () => {
        const processor = createAiSdkStreamProcessor();

        processor.consumePart(
            toolInputStart('call_1', 'builtin__read', {
                providerMetadata: { anthropic: { id: 'start-id' } },
            })
        );

        processor.consumePart(
            toolCall(
                'call_1',
                'builtin__read',
                { filePath: 'a.txt' },
                {
                    providerMetadata: { anthropic: { id: 'final-id' } },
                }
            )
        );

        const finish = processor.buildFinishChunk('tool-calls');

        expect(finish.toolCalls?.[0]?.providerOptions).toEqual({ anthropic: { id: 'final-id' } });
    });

    it('user gets no metadata when the provider sent none', () => {
        const processor = createAiSdkStreamProcessor();

        processor.consumePart(toolInputStart('call_1', 'builtin__read'));
        processor.consumePart(toolCall('call_1', 'builtin__read', { filePath: 'a.txt' }));

        expect(
            processor.buildFinishChunk('tool-calls').toolCalls?.[0]?.providerOptions
        ).toBeUndefined();
    });

    it('user gets reasoning metadata merged across the whole thinking block', () => {
        const processor = createAiSdkStreamProcessor({ modelId: 'gpt-5.2' });

        const start = processor.consumePart({
            type: 'reasoning-start',
            id: 'event-1',
            providerMetadata: { openai: { itemId: 'item-1' } },
        } as TestStreamPart);

        const end = processor.consumePart({
            type: 'reasoning-end',
            id: 'event-2',
            providerMetadata: { openai: { itemId: 'item-1', reasoningEncryptedContent: 'enc' } },
        } as TestStreamPart);

        // Both events name the same reasoning item, so the end event carries both fields.
        expect(start[0]?.reasoningProviderOptions).toEqual({ openai: { itemId: 'item-1' } });
        expect(end[0]?.reasoningProviderOptions).toEqual({
            openai: { itemId: 'item-1', reasoningEncryptedContent: 'enc' },
        });
    });

    it('user gets the earlier reasoning metadata kept when a later event carries none', () => {
        const processor = createAiSdkStreamProcessor();

        processor.consumePart({
            type: 'reasoning-start',
            id: 'r1',
            providerMetadata: { openai: { itemId: 'r1', itemIdField: 'x' } },
        } as TestStreamPart);

        const end = processor.consumePart({
            type: 'reasoning-end',
            id: 'r1',
        } as TestStreamPart);

        expect(end[0]?.reasoningProviderOptions).toEqual({
            openai: { itemId: 'r1', itemIdField: 'x' },
        });
    });

    it('user gets reasoning events keyed by their own id when no item id was sent', () => {
        const processor = createAiSdkStreamProcessor();

        const start = processor.consumePart({
            type: 'reasoning-start',
            id: 'plain-1',
            providerMetadata: { deepseek: { signature: 'sig' } },
        } as TestStreamPart);

        const end = processor.consumePart({
            type: 'reasoning-end',
            id: 'plain-1',
            providerMetadata: { deepseek: { extra: 'more' } },
        } as TestStreamPart);

        expect(start[0]?.reasoningProviderOptions).toEqual({ deepseek: { signature: 'sig' } });
        expect(end[0]?.reasoningProviderOptions).toEqual({
            deepseek: { signature: 'sig', extra: 'more' },
        });
    });

    it('user gets the reasoning text with no metadata when the provider sent none', () => {
        const processor = createAiSdkStreamProcessor();

        const chunks = processor.consumePart({
            type: 'reasoning-delta',
            id: 'r1',
            text: 'thinking',
        } as TestStreamPart);

        expect(chunks).toEqual([{ content: '', done: false, reasoning: 'thinking' }]);
        expect(chunks[0]).not.toHaveProperty('reasoningProviderOptions');
    });
});
