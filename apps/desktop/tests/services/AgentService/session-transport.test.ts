import type { MessageRow } from '@database/queries/messages';
import { createMessagePart, createMessageRow } from '@tests/utils/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadSessionTransportMessages } from '@/services/AgentService/session/transport';

const mocks = vi.hoisted(() => ({
    findMessagesBySessionId: vi.fn<() => Promise<MessageRow[]>>(),
}));
vi.mock('@database/queries/messages', () => ({
    findMessagesBySessionId: mocks.findMessagesBySessionId,
}));

function callPart(id: number, kind: 'builtin' | 'mcp', callId: string) {
    return createMessagePart({
        id,
        message_id: 11,
        type: 'tool_call',
        sort_order: id,
        data: JSON.stringify({
            toolCallId: callId,
            toolKind: kind,
            ...(kind === 'builtin' ? { tool_id: 'bash' } : { tool_name: 'lookup', server_id: 9 }),
            input: '{}',
            status: 'success',
            duration_ms: 12,
        }),
    });
}
function resultRow(
    id: number,
    kind: 'builtin' | 'mcp' | null,
    callId: string | null,
    content: string
) {
    return createMessageRow({
        id,
        role: 'tool_result',
        parts: [
            createMessagePart({
                id,
                message_id: id,
                type: 'tool_result',
                content,
                data: JSON.stringify({ toolCallId: callId, toolKind: kind }),
            }),
        ],
    });
}

describe('AgentService session transport', () => {
    beforeEach(() => {
        mocks.findMessagesBySessionId.mockReset();
    });

    it('reads multiple tool calls from one message and matches reversed results by part identity', async () => {
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({ id: 10, content: 'run both' }),
            createMessageRow({
                id: 11,
                role: 'tool_call',
                parts: [callPart(1, 'builtin', 'call_builtin'), callPart(2, 'mcp', 'call_mcp')],
            }),
            resultRow(12, 'mcp', 'call_mcp', 'mcp result'),
            resultRow(13, 'builtin', 'call_builtin', 'builtin result'),
        ]);
        const messages = await loadSessionTransportMessages({ sessionId: 1 });
        expect(messages[1]).toEqual({
            role: 'assistant',
            content: [],
            tool_calls: [
                { id: 'call_builtin', name: 'builtin__bash', arguments: '{}' },
                { id: 'call_mcp', name: 'mcp__9__lookup', arguments: '{}' },
            ],
        });
        expect(messages.slice(2)).toEqual([
            {
                role: 'tool',
                tool_call_id: 'call_mcp',
                name: 'mcp__9__lookup',
                content: 'mcp result',
            },
            {
                role: 'tool',
                tool_call_id: 'call_builtin',
                name: 'builtin__bash',
                content: 'builtin result',
            },
        ]);
        expect(mocks.findMessagesBySessionId).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('inserts placeholder results for an interrupted call with no persisted result', async () => {
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({ id: 10, content: 'run a tool' }),
            createMessageRow({
                id: 11,
                role: 'tool_call',
                parts: [callPart(1, 'builtin', 'call_1')],
            }),
            createMessageRow({ id: 12, role: 'assistant', content: 'request was interrupted' }),
        ]);
        expect(await loadSessionTransportMessages({ sessionId: 1 })).toEqual([
            { role: 'user', content: 'run a tool' },
            {
                role: 'assistant',
                content: [],
                tool_calls: [{ id: 'call_1', name: 'builtin__bash', arguments: '{}' }],
            },
            {
                role: 'tool',
                tool_call_id: 'call_1',
                name: 'builtin__bash',
                content: 'Missing historical tool result.',
            },
            { role: 'assistant', content: [{ type: 'text', text: 'request was interrupted' }] },
        ]);
    });

    it('does not guess a missing result identity from FIFO order', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({
                id: 11,
                role: 'tool_call',
                parts: [callPart(1, 'builtin', 'call_1')],
            }),
            resultRow(12, null, null, 'orphan result'),
        ]);
        const messages = await loadSessionTransportMessages({ sessionId: 1 });
        expect(messages[1]).toMatchObject({
            tool_call_id: 'call_1',
            content: 'Missing historical tool result.',
        });
        expect(warn).toHaveBeenCalledOnce();
    });

    it('does not attach a result to a call from a different tool kind', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({
                id: 11,
                role: 'tool_call',
                parts: [callPart(1, 'builtin', 'call_1')],
            }),
            resultRow(12, 'mcp', 'call_1', 'wrong source result'),
        ]);
        const messages = await loadSessionTransportMessages({ sessionId: 1 });
        expect(messages[1]).toMatchObject({
            tool_call_id: 'call_1',
            content: 'Missing historical tool result.',
        });
        expect(warn).toHaveBeenCalledOnce();
    });

    it('preserves text and reasoning order directly from parts', async () => {
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({
                role: 'assistant',
                parts: [
                    createMessagePart({ id: 1, type: 'reasoning', content: 'plan', sort_order: 0 }),
                    createMessagePart({ id: 2, type: 'text', content: 'answer', sort_order: 1 }),
                    createMessagePart({
                        id: 3,
                        type: 'reasoning',
                        content: 'review',
                        sort_order: 2,
                    }),
                    createMessagePart({ id: 4, type: 'text', content: 'done', sort_order: 3 }),
                ],
            }),
        ]);
        expect(await loadSessionTransportMessages({ sessionId: 1 })).toEqual([
            {
                role: 'assistant',
                content: [
                    { type: 'reasoning', text: 'plan' },
                    { type: 'text', text: 'answer' },
                    { type: 'reasoning', text: 'review' },
                    { type: 'text', text: 'done' },
                ],
            },
        ]);
    });

    it('omits blank text and reasoning parts from provider transport', async () => {
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({
                role: 'assistant',
                parts: [
                    createMessagePart({ id: 1, type: 'text', content: '', sort_order: 0 }),
                    createMessagePart({ id: 2, type: 'reasoning', content: '   ', sort_order: 1 }),
                    createMessagePart({ id: 3, type: 'text', content: 'Answer', sort_order: 2 }),
                    createMessagePart({
                        id: 4,
                        type: 'reasoning',
                        content: 'Thought',
                        sort_order: 3,
                    }),
                ],
            }),
        ]);

        expect(await loadSessionTransportMessages({ sessionId: 1 })).toEqual([
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Answer' },
                    { type: 'reasoning', text: 'Thought' },
                ],
            },
        ]);
    });

    it('returns no history without querying when there is no session', async () => {
        expect(await loadSessionTransportMessages({})).toEqual([]);
        expect(mocks.findMessagesBySessionId).not.toHaveBeenCalled();
    });
});
