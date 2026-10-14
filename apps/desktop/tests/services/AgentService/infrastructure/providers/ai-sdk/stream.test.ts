import type { TextStreamPart, ToolSet } from 'ai';
import { describe, expect, it } from 'vitest';

import { createAiSdkStreamProcessor } from '@/services/AgentService/infrastructure/providers/ai-sdk/stream';

type TestStreamPart = TextStreamPart<ToolSet>;

function toolInputStart(id: string, toolName: string): TestStreamPart {
    return {
        type: 'tool-input-start',
        id,
        toolName,
    };
}

function toolInputDelta(id: string, delta: string): TestStreamPart {
    return {
        type: 'tool-input-delta',
        id,
        delta,
    };
}

function toolCall(toolCallId: string, toolName: string, input: unknown): TestStreamPart {
    return {
        type: 'tool-call',
        toolCallId,
        toolName,
        input,
        dynamic: true,
    };
}

describe('AI SDK stream processor', () => {
    it.each(['start', 'end'] as const)('preserves the text %s boundary', (state) => {
        const processor = createAiSdkStreamProcessor();
        expect(
            processor.consumePart({
                type: state === 'start' ? 'text-start' : 'text-end',
                id: 'text-1',
            })
        ).toEqual([{ content: '', done: false, textState: state }]);
    });

    it('keeps a streamed tool call when the final event omits the tool name', () => {
        const processor = createAiSdkStreamProcessor();

        processor.consumePart(toolInputStart('call_1', 'builtin__read'));
        processor.consumePart(toolInputDelta('call_1', '{"filePath":"notes.txt"}'));

        const chunks = processor.consumePart(toolCall('call_1', '', {}));
        const finish = processor.buildFinishChunk('tool-calls');

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.toolCallDeltas?.[0]).toMatchObject({
            callId: 'call_1',
            name: 'builtin__read',
            argumentsBuffer: '{"filePath":"notes.txt"}',
            isComplete: true,
        });
        expect(finish.toolCalls).toEqual([
            expect.objectContaining({
                id: 'call_1',
                name: 'builtin__read',
                arguments: '{"filePath":"notes.txt"}',
            }),
        ]);
        expect(finish.finishReason).toBe('tool_calls');
    });

    it('uses the final tool call name when it differs from the streamed name', () => {
        const processor = createAiSdkStreamProcessor();

        processor.consumePart(toolInputStart('call_1', 'builtin__read'));
        processor.consumePart(toolInputDelta('call_1', '{"filePath":"notes.txt"}'));

        const chunks = processor.consumePart(toolCall('call_1', 'builtin__glob', {}));
        const finish = processor.buildFinishChunk('tool-calls');

        expect(chunks[0]?.toolCallDeltas?.[0]).toMatchObject({
            callId: 'call_1',
            name: 'builtin__glob',
            argumentsBuffer: '{"filePath":"notes.txt"}',
            isComplete: true,
        });
        expect(finish.toolCalls).toEqual([
            expect.objectContaining({
                id: 'call_1',
                name: 'builtin__glob',
                arguments: '{"filePath":"notes.txt"}',
            }),
        ]);
    });

    it('drops final tool call events when no tool name can be resolved', () => {
        const processor = createAiSdkStreamProcessor();

        const chunks = processor.consumePart(toolCall('call_1', '', { filePath: 'notes.txt' }));
        const finish = processor.buildFinishChunk('tool-calls');

        expect(chunks).toEqual([]);
        expect(finish.toolCalls).toBeUndefined();
    });

    it('resolves multiple streamed tool calls independently', () => {
        const processor = createAiSdkStreamProcessor();

        processor.consumePart(toolInputStart('call_1', 'builtin__read'));
        processor.consumePart(toolInputDelta('call_1', '{"filePath":"notes.txt"}'));
        processor.consumePart(toolInputStart('call_2', 'builtin__write'));
        processor.consumePart(toolInputDelta('call_2', '{"pattern":"*.ts"}'));

        const firstChunks = processor.consumePart(toolCall('call_1', '', {}));
        const secondChunks = processor.consumePart(toolCall('call_2', 'builtin__glob', {}));
        const droppedChunks = processor.consumePart(toolCall('call_3', '', { q: 'ignored' }));
        const finish = processor.buildFinishChunk('tool-calls');

        expect(firstChunks[0]?.toolCallDeltas?.[0]).toMatchObject({
            callId: 'call_1',
            name: 'builtin__read',
        });
        expect(secondChunks[0]?.toolCallDeltas?.[0]).toMatchObject({
            callId: 'call_2',
            name: 'builtin__glob',
        });
        expect(droppedChunks).toEqual([]);
        expect(finish.toolCalls).toEqual([
            expect.objectContaining({
                id: 'call_1',
                name: 'builtin__read',
                arguments: '{"filePath":"notes.txt"}',
            }),
            expect.objectContaining({
                id: 'call_2',
                name: 'builtin__glob',
                arguments: '{"pattern":"*.ts"}',
            }),
        ]);
    });
});

describe('AI SDK reasoning lifecycle', () => {
    it('forwards reasoning boundaries even before the first text delta', () => {
        const processor = createAiSdkStreamProcessor();
        expect(processor.consumePart({ type: 'reasoning-start', id: 'r1' })).toEqual([
            { content: '', done: false, reasoningState: 'start' },
        ]);
        expect(processor.consumePart({ type: 'reasoning-delta', id: 'r1', text: 'Think' })).toEqual(
            [{ content: '', done: false, reasoning: 'Think' }]
        );
        expect(processor.consumePart({ type: 'reasoning-end', id: 'r1' })).toEqual([
            { content: '', done: false, reasoningState: 'end' },
        ]);
    });

    it('accumulates reasoning provider metadata across start/delta/end by itemId', () => {
        const processor = createAiSdkStreamProcessor({ modelId: 'gpt-5.2' });

        expect(
            processor.consumePart({
                type: 'reasoning-start',
                id: 'rs_1',
                providerMetadata: { openai: { itemId: 'rs_1' } },
            })
        ).toEqual([
            {
                content: '',
                done: false,
                reasoningState: 'start',
                reasoningProviderOptions: { openai: { itemId: 'rs_1' } },
            },
        ]);

        expect(
            processor.consumePart({
                type: 'reasoning-delta',
                id: 'rs_1',
                text: 'Think',
                providerMetadata: { openai: { itemId: 'rs_1' } },
            })
        ).toEqual([
            {
                content: '',
                done: false,
                reasoning: 'Think',
                reasoningProviderOptions: { openai: { itemId: 'rs_1' } },
            },
        ]);

        expect(
            processor.consumePart({
                type: 'reasoning-end',
                id: 'rs_1',
                providerMetadata: {
                    openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc' },
                },
            })
        ).toEqual([
            {
                content: '',
                done: false,
                reasoningState: 'end',
                reasoningProviderOptions: {
                    openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc' },
                },
            },
        ]);
    });

    it('omits reasoning provider metadata when the stream carries none', () => {
        const processor = createAiSdkStreamProcessor();
        expect(processor.consumePart({ type: 'reasoning-delta', id: 'r1', text: 'x' })).toEqual([
            { content: '', done: false, reasoning: 'x' },
        ]);
    });
});
