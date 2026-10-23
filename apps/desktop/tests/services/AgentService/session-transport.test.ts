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

function callPart(id: number, kind: 'builtin' | 'mcp', callId: string, result?: string) {
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
            ...(result === undefined ? {} : { output: result }),
        }),
    });
}

describe('a saved conversation is replayed to the model', () => {
    beforeEach(() => {
        mocks.findMessagesBySessionId.mockReset();
    });

    it('user sees multiple tool calls from one message with each result after its call', async () => {
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({ id: 10, content: 'run both' }),
            createMessageRow({
                id: 11,
                role: 'tool_call',
                parts: [
                    callPart(1, 'builtin', 'call_builtin', 'builtin result'),
                    callPart(2, 'mcp', 'call_mcp', 'mcp result'),
                ],
            }),
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
                tool_call_id: 'call_builtin',
                name: 'builtin__bash',
                content: 'builtin result',
            },
            {
                role: 'tool',
                tool_call_id: 'call_mcp',
                name: 'mcp__9__lookup',
                content: 'mcp result',
            },
        ]);
        expect(mocks.findMessagesBySessionId).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('user sees a placeholder result for an interrupted call with no saved result', async () => {
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

    it('user sees reasoning and text kept on a tool-call message beside its call parts', async () => {
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({
                id: 11,
                role: 'tool_call',
                parts: [
                    createMessagePart({
                        id: 1,
                        message_id: 11,
                        type: 'reasoning',
                        content: 'need a command',
                        sort_order: 0,
                    }),
                    createMessagePart({
                        id: 2,
                        message_id: 11,
                        type: 'text',
                        content: 'Running it',
                        sort_order: 1,
                    }),
                    callPart(3, 'builtin', 'call_1', 'builtin result'),
                ],
            }),
        ]);

        expect(await loadSessionTransportMessages({ sessionId: 1 })).toEqual([
            {
                role: 'assistant',
                content: [
                    { type: 'reasoning', text: 'need a command' },
                    { type: 'text', text: 'Running it' },
                ],
                tool_calls: [{ id: 'call_1', name: 'builtin__bash', arguments: '{}' }],
            },
            {
                role: 'tool',
                tool_call_id: 'call_1',
                name: 'builtin__bash',
                content: 'builtin result',
            },
        ]);
    });

    it('user sees text and reasoning replayed in their original order', async () => {
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

    it('user sees reasoning provider options restored from the saved part', async () => {
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({
                role: 'assistant',
                parts: [
                    createMessagePart({
                        id: 1,
                        type: 'reasoning',
                        content: 'plan',
                        sort_order: 0,
                        data: JSON.stringify({
                            openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc' },
                        }),
                    }),
                    createMessagePart({ id: 2, type: 'text', content: 'answer', sort_order: 1 }),
                ],
            }),
        ]);
        expect(await loadSessionTransportMessages({ sessionId: 1 })).toEqual([
            {
                role: 'assistant',
                content: [
                    {
                        type: 'reasoning',
                        text: 'plan',
                        providerOptions: {
                            openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc' },
                        },
                    },
                    { type: 'text', text: 'answer' },
                ],
            },
        ]);
    });

    it('user sees malformed reasoning part data ignored', async () => {
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({
                role: 'assistant',
                parts: [
                    createMessagePart({
                        id: 1,
                        type: 'reasoning',
                        content: 'plan',
                        sort_order: 0,
                        data: '[]',
                    }),
                ],
            }),
        ]);
        expect(await loadSessionTransportMessages({ sessionId: 1 })).toEqual([
            { role: 'assistant', content: [{ type: 'reasoning', text: 'plan' }] },
        ]);
    });

    it('user does not see blank text and reasoning parts sent to the model', async () => {
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

    it('user does not see assistant rows with no renderable content sent', async () => {
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({ id: 10, content: 'Question' }),
            createMessageRow({
                id: 11,
                role: 'assistant',
                parts: [
                    createMessagePart({
                        id: 1,
                        message_id: 11,
                        type: 'attachment',
                        data: '{"attachmentId":1}',
                        sort_order: 0,
                    }),
                ],
            }),
            createMessageRow({ id: 12, role: 'assistant', content: 'Answer' }),
        ]);

        expect(await loadSessionTransportMessages({ sessionId: 1 })).toEqual([
            { role: 'user', content: 'Question' },
            { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
        ]);
    });

    it('user sees no history queried when there is no session', async () => {
        expect(await loadSessionTransportMessages({})).toEqual([]);
        expect(mocks.findMessagesBySessionId).not.toHaveBeenCalled();
    });
});
