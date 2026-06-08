import type { MessageRow, ToolLogHistoryRow } from '@database/queries/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadSessionTransportMessages } from '@/services/AgentService/session/transport';

const BASE_TIME = '2026-05-31T10:00:00.000Z';

const mocks = vi.hoisted(() => ({
    findMessagesBySessionId: vi.fn<() => Promise<MessageRow[]>>(),
    findToolLogRowsBySessionId: vi.fn<() => Promise<ToolLogHistoryRow[]>>(),
}));

vi.mock('@database/queries/messages', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@database/queries/messages')>();

    return {
        ...actual,
        findMessagesBySessionId: mocks.findMessagesBySessionId,
        findToolLogRowsBySessionId: mocks.findToolLogRowsBySessionId,
    };
});

function createMessageRow(overrides: Partial<MessageRow>): MessageRow {
    return {
        id: 1,
        session_id: 1,
        role: 'user',
        content: '',
        reasoning: null,
        attachments: [],
        tool_call_id: null,
        tool_name: null,
        tool_input: null,
        tool_log_ref_id: null,
        tool_status: null,
        tool_duration_ms: null,
        server_id: null,
        builtin_conversation_semantic_json: null,
        tool_log_id: null,
        tool_log_kind: null,
        created_at: BASE_TIME,
        updated_at: BASE_TIME,
        ...overrides,
    };
}

function createToolLog(overrides: Partial<ToolLogHistoryRow>): ToolLogHistoryRow {
    return {
        source: 'builtin',
        log_id: 1,
        tool_call_id: 'call_1',
        tool_name: 'bash',
        tool_input: '{}',
        message_id: 1,
        created_at: BASE_TIME,
        tool_status: 'success',
        tool_duration_ms: 1,
        server_id: null,
        builtin_conversation_semantic_json: null,
        ...overrides,
    };
}

describe('AgentService session transport', () => {
    beforeEach(() => {
        mocks.findMessagesBySessionId.mockReset();
        mocks.findToolLogRowsBySessionId.mockReset();
        mocks.findToolLogRowsBySessionId.mockResolvedValue([]);
    });

    it('inserts placeholder tool results for historical tool calls without persisted results', async () => {
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({
                id: 10,
                role: 'user',
                content: 'run a tool',
            }),
            createMessageRow({
                id: 11,
                role: 'tool_call',
                content: '',
                tool_call_id: 'call_f58b800del5b468cb4296985',
                tool_name: 'builtin__ask_user',
                tool_input: JSON.stringify({ question: 'Continue?' }),
            }),
            createMessageRow({
                id: 12,
                role: 'assistant',
                content: 'request was interrupted',
            }),
        ]);

        const messages = await loadSessionTransportMessages({ sessionId: 1 });

        expect(messages).toEqual([
            {
                role: 'user',
                content: 'run a tool',
            },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    {
                        id: 'call_f58b800del5b468cb4296985',
                        name: 'builtin__ask_user',
                        arguments: JSON.stringify({ question: 'Continue?' }),
                    },
                ],
            },
            {
                role: 'tool',
                tool_call_id: 'call_f58b800del5b468cb4296985',
                name: 'builtin__ask_user',
                content: 'Missing historical tool result.',
            },
            {
                role: 'assistant',
                content: 'request was interrupted',
            },
        ]);
    });

    it('uses the next orphaned tool result for a pending tool call before inserting placeholders', async () => {
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({
                id: 20,
                role: 'user',
                content: 'delete temp files',
            }),
            createMessageRow({
                id: 21,
                role: 'tool_call',
                content: '',
                tool_call_id: 'call_rejected',
                tool_name: 'builtin__bash',
                tool_input: JSON.stringify({ command: 'Remove-Item temp.txt' }),
            }),
            createMessageRow({
                id: 22,
                role: 'tool_result',
                content: '用户已拒绝执行此命令',
                tool_log_id: null,
                tool_log_kind: 'builtin',
            }),
            createMessageRow({
                id: 23,
                role: 'assistant',
                content: '未执行删除。',
            }),
        ]);

        const messages = await loadSessionTransportMessages({ sessionId: 1 });

        expect(messages).toEqual([
            {
                role: 'user',
                content: 'delete temp files',
            },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    {
                        id: 'call_rejected',
                        name: 'builtin__bash',
                        arguments: JSON.stringify({ command: 'Remove-Item temp.txt' }),
                    },
                ],
            },
            {
                role: 'tool',
                tool_call_id: 'call_rejected',
                name: 'builtin__bash',
                content: '用户已拒绝执行此命令',
            },
            {
                role: 'assistant',
                content: '未执行删除。',
            },
        ]);
    });

    it('does not resolve legacy tool results to MCP when built-in and MCP log ids collide', async () => {
        mocks.findToolLogRowsBySessionId.mockResolvedValue([
            createToolLog({
                source: 'builtin',
                log_id: 1,
                tool_call_id: 'call_builtin',
                tool_name: 'bash',
                tool_input: JSON.stringify({ command: 'echo builtin' }),
                message_id: 31,
                server_id: null,
            }),
            createToolLog({
                source: 'mcp',
                log_id: 1,
                tool_call_id: 'call_mcp',
                tool_name: 'lookup',
                tool_input: JSON.stringify({ query: 'mcp' }),
                message_id: 31,
                server_id: 9,
            }),
        ]);
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({
                id: 30,
                role: 'user',
                content: 'run both tools',
            }),
            createMessageRow({
                id: 31,
                role: 'tool_call',
                content: '',
                tool_call_id: 'call_builtin',
                tool_name: 'builtin__bash',
                tool_input: JSON.stringify({ command: 'echo builtin' }),
            }),
            createMessageRow({
                id: 31,
                role: 'tool_call',
                content: '',
                tool_call_id: 'call_mcp',
                tool_name: 'mcp__9__lookup',
                tool_input: JSON.stringify({ query: 'mcp' }),
            }),
            createMessageRow({
                id: 32,
                role: 'tool_result',
                content: 'builtin result',
                tool_log_id: 1,
                tool_log_kind: null,
            }),
            createMessageRow({
                id: 33,
                role: 'tool_result',
                content: 'mcp result',
                tool_log_id: 1,
                tool_log_kind: null,
            }),
            createMessageRow({
                id: 34,
                role: 'assistant',
                content: 'done',
            }),
        ]);

        const messages = await loadSessionTransportMessages({ sessionId: 1 });

        expect(messages).toEqual([
            {
                role: 'user',
                content: 'run both tools',
            },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    {
                        id: 'call_builtin',
                        name: 'builtin__bash',
                        arguments: JSON.stringify({ command: 'echo builtin' }),
                    },
                    {
                        id: 'call_mcp',
                        name: 'mcp__9__lookup',
                        arguments: JSON.stringify({ query: 'mcp' }),
                    },
                ],
            },
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
            {
                role: 'assistant',
                content: 'done',
            },
        ]);
    });
});
