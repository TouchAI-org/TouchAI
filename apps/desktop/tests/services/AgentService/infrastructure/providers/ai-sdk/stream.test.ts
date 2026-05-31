import { describe, expect, it } from 'vitest';

import { createAiSdkStreamProcessor } from '@/services/AgentService/infrastructure/providers/ai-sdk/stream';

describe('AI SDK stream processor', () => {
    it('keeps a streamed tool call when the final event omits the tool name', () => {
        const processor = createAiSdkStreamProcessor();

        processor.consumePart({
            type: 'tool-input-start',
            id: 'call_1',
            toolName: 'builtin__read',
        } as never);
        processor.consumePart({
            type: 'tool-input-delta',
            id: 'call_1',
            delta: '{"filePath":"notes.txt"}',
        } as never);

        const chunks = processor.consumePart({
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: '',
            input: {},
        } as never);
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
});
