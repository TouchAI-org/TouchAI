import type { MessageRow } from '@database/queries/messages';
import type { SessionTurnAttemptHistoryRow } from '@database/queries/sessionTurnAttempts';
import type { SessionTurnHistoryRow } from '@database/queries/sessionTurns';
import { createMessagePart, createMessageRow } from '@tests/utils/messages';
import { describe, expect, it, vi } from 'vitest';

import {
    buildSessionHistory,
    buildSessionHistoryFromData,
} from '@/services/AgentService/session/history';
import { parseDbDateTimestamp } from '@/utils/date';
import { selectToolCalls } from '@/utils/session';

const { findAllMcpServersMock } = vi.hoisted(() => ({
    findAllMcpServersMock: vi.fn(),
}));

vi.mock('@database/queries/mcpServers', () => ({
    findAllMcpServers: findAllMcpServersMock,
}));

const BASE_TIME = '2026-05-22T10:00:00.000Z';

function createToolCallRow(messageCreatedAt: string, toolLogCreatedAt: string): MessageRow {
    return {
        id: 11,
        session_id: 7,
        role: 'tool_call',
        created_at: messageCreatedAt,
        updated_at: messageCreatedAt,
        attachments: [],
        parts: [
            {
                id: 101,
                message_id: 11,
                type: 'tool_call',
                content: '',
                sort_order: 0,
                attachment_id: null,
                started_at: null,
                ended_at: null,
                data: JSON.stringify({
                    toolCallId: 'call-bash-1',
                    tool_id: 'bash',
                    input: JSON.stringify({
                        command: 'Write-Output "alpha"',
                    }),
                    toolKind: 'builtin',
                    status: 'pending',
                }),
                tool_call_id: 'call-bash-1',
                tool_kind: 'builtin',
                created_at: toolLogCreatedAt,
                updated_at: toolLogCreatedAt,
            },
        ],
    };
}

function builtinToolPart(options: {
    id: number;
    sortOrder: number;
    toolId: string;
    callId: string;
    input?: Record<string, unknown>;
    output?: string | null;
    status?: string | null;
    durationMs?: number | null;
    conversationSemantic?: Record<string, unknown> | null;
    structuredPayload?: Record<string, unknown> | null;
}) {
    return createMessagePart({
        id: options.id,
        message_id: 2,
        type: 'tool_call',
        content: '',
        sort_order: options.sortOrder,
        tool_call_id: options.callId,
        tool_kind: 'builtin',
        data: JSON.stringify({
            toolCallId: options.callId,
            toolKind: 'builtin',
            tool_id: options.toolId,
            input: JSON.stringify(options.input ?? {}),
            output: options.output ?? null,
            status: options.status === undefined ? 'success' : options.status,
            duration_ms: options.durationMs ?? null,
            error_message: null,
            approval_state: 'none',
            approval_summary: null,
            conversation_semantic_json: options.conversationSemantic
                ? JSON.stringify(options.conversationSemantic)
                : null,
            structured_payload_json: options.structuredPayload
                ? JSON.stringify(options.structuredPayload)
                : null,
        }),
    });
}

/** A tool part with the stored JSON written verbatim, for dirty-data cases. */
function rawBuiltinToolPart(id: number, sortOrder: number, data: Record<string, unknown>) {
    return createMessagePart({
        id,
        message_id: 2,
        type: 'tool_call',
        content: '',
        sort_order: sortOrder,
        tool_call_id: typeof data.toolCallId === 'string' ? data.toolCallId : null,
        tool_kind: 'builtin',
        data: JSON.stringify(data),
    });
}

function mcpToolPart(options: {
    id: number;
    sortOrder: number;
    callId: string;
    toolName: string;
    serverId: number;
    output?: string | null;
    status?: string;
}) {
    return createMessagePart({
        id: options.id,
        message_id: 2,
        type: 'tool_call',
        content: '',
        sort_order: options.sortOrder,
        tool_call_id: options.callId,
        tool_kind: 'mcp',
        data: JSON.stringify({
            toolCallId: options.callId,
            toolKind: 'mcp',
            server_id: options.serverId,
            tool_name: options.toolName,
            input: JSON.stringify({ path: 'README.md' }),
            output: options.output ?? null,
            status: options.status ?? 'success',
            duration_ms: 12,
            error_message: null,
        }),
    });
}

function textPart(id: number, sortOrder: number, content: string) {
    return createMessagePart({
        id,
        message_id: 2,
        type: 'text',
        content,
        sort_order: sortOrder,
    });
}

function userRow(id: number, content: string): MessageRow {
    return createMessageRow({ id, role: 'user', content });
}

function toolCallRow(id: number, parts: MessageRow['parts']): MessageRow {
    return createMessageRow({ id, role: 'tool_call', parts });
}

function assistantRow(id: number, content: string): MessageRow {
    return createMessageRow({ id, role: 'assistant', content });
}

async function build(
    messages: MessageRow[],
    turns: SessionTurnHistoryRow[] = [],
    attempts: SessionTurnAttemptHistoryRow[] = [],
    resolveServerName: (serverId: number | null) => string = () => ''
) {
    return buildSessionHistory({ messages, turns, attempts, resolveServerName });
}

describe('user reopens a conversation that had a running tool', () => {
    it('user sees a builtin tool call restored with the time it started', async () => {
        findAllMcpServersMock.mockResolvedValue([]);
        const messageCreatedAt = '2026-05-29T00:00:00.000Z';
        const toolLogCreatedAt = '2026-05-29T00:00:03.000Z';

        const history = await buildSessionHistoryFromData({
            messages: [createToolCallRow(messageCreatedAt, toolLogCreatedAt)],
            turns: [] as SessionTurnHistoryRow[],
            attempts: [] as SessionTurnAttemptHistoryRow[],
        });

        expect(history).toHaveLength(1);
        const message = history[0]!;
        expect(message).toMatchObject({
            role: 'assistant',
        });
        expect(selectToolCalls(message)).toEqual([
            expect.objectContaining({
                id: 'call-bash-1',
                status: 'executing',
                startedAt: parseDbDateTimestamp(toolLogCreatedAt),
            }),
        ]);
        expect(message.parts).toEqual([
            expect.objectContaining({
                type: 'tool_call',
                toolCall: expect.objectContaining({ id: 'call-bash-1' }),
            }),
        ]);
    });
});

describe('user reopens a conversation that used tools', () => {
    it('user sees the prose before a tool call kept as text and the call beside it', async () => {
        const history = await build(
            [
                userRow(1, 'run it'),
                toolCallRow(2, [
                    textPart(1, 0, 'Let me check.'),
                    builtinToolPart({
                        id: 2,
                        sortOrder: 1,
                        toolId: 'bash',
                        callId: 'call-1',
                        input: { command: 'dir' },
                        output: 'file.txt',
                    }),
                ]),
            ],
            [],
            [],
            () => ''
        );

        expect(history[1]).toMatchObject({ role: 'assistant', content: 'Let me check.' });
        expect(history[1]?.parts.map((part) => part.type)).toEqual(['text', 'tool_call']);
        expect(selectToolCalls(history[1]!)[0]).toMatchObject({
            id: 'call-1',
            name: 'bash',
            status: 'completed',
            result: 'file.txt',
        });
    });

    it('user never sees a tool result replayed as assistant prose', async () => {
        const history = await build([
            userRow(1, 'run it'),
            toolCallRow(2, [
                builtinToolPart({
                    id: 1,
                    sortOrder: 0,
                    toolId: 'bash',
                    callId: 'call-1',
                    output: null,
                }),
                textPart(2, 1, 'file.txt'),
            ]),
        ]);

        const assistant = history[1]!;
        expect(assistant.content).toBe('');
        // The trailing text is the tool result, so it belongs to the call, not the reply.
        expect(selectToolCalls(assistant)[0]?.result).toBe('file.txt');
        expect(assistant.parts.filter((part) => part.type === 'text')).toHaveLength(0);
    });

    it('user sees a tool result that was never stored left empty instead of borrowed from another call', async () => {
        const history = await build([
            userRow(1, 'run both'),
            toolCallRow(2, [
                builtinToolPart({ id: 1, sortOrder: 0, toolId: 'bash', callId: 'call-1' }),
                builtinToolPart({ id: 2, sortOrder: 1, toolId: 'bash', callId: 'call-2' }),
                textPart(3, 2, 'shared output'),
            ]),
        ]);

        const toolCalls = selectToolCalls(history[1]!);

        expect(toolCalls).toHaveLength(2);
        expect(toolCalls.map((call) => call.result ?? null)).toEqual([null, null]);
    });

    it('user sees an interrupted tool call restored as still running', async () => {
        const history = await build([
            userRow(1, 'run it'),
            toolCallRow(2, [
                builtinToolPart({
                    id: 1,
                    sortOrder: 0,
                    toolId: 'bash',
                    callId: 'call-1',
                    status: 'pending',
                }),
            ]),
        ]);

        expect(selectToolCalls(history[1]!)[0]?.status).toBe('executing');
    });

    it('user sees a failed tool call marked as an error with its message kept', async () => {
        const history = await build([
            userRow(1, 'run it'),
            toolCallRow(2, [
                builtinToolPart({
                    id: 1,
                    sortOrder: 0,
                    toolId: 'bash',
                    callId: 'call-1',
                    status: 'error',
                    output: 'Command failed with exit code 1',
                }),
            ]),
        ]);

        expect(selectToolCalls(history[1]!)[0]).toMatchObject({
            status: 'error',
            isError: true,
            result: 'Command failed with exit code 1',
        });
    });

    it('user sees a tool call the user cancelled restored as cancelled rather than failed', async () => {
        const history = await build([
            userRow(1, 'run it'),
            toolCallRow(2, [
                builtinToolPart({
                    id: 1,
                    sortOrder: 0,
                    toolId: 'bash',
                    callId: 'call-1',
                    status: 'error',
                    output: 'Request cancelled',
                }),
            ]),
        ]);

        expect(selectToolCalls(history[1]!)[0]).toMatchObject({
            status: 'cancelled',
            isError: false,
        });
    });

    it('user sees an MCP tool call named after its server', async () => {
        const history = await build(
            [
                userRow(1, 'read a file'),
                toolCallRow(2, [
                    mcpToolPart({
                        id: 1,
                        sortOrder: 0,
                        callId: 'call-1',
                        toolName: 'read_file',
                        serverId: 7,
                        output: 'contents',
                    }),
                ]),
            ],
            [],
            [],
            (serverId) => (serverId === 7 ? 'filesystem' : 'unknown')
        );

        expect(selectToolCalls(history[1]!)[0]).toMatchObject({
            id: 'call-1',
            name: 'read_file',
            namespacedName: 'mcp__7__read_file',
            source: 'mcp',
            serverId: 7,
            serverName: 'filesystem',
            result: 'contents',
        });
    });

    it('user sees the stored search sources replayed with the tool result', async () => {
        const sources = {
            kind: 'web_search_sources',
            sources: [
                { id: 's1', title: 'TouchAI docs', url: 'https://example.test/docs' },
                { id: 's2', title: 'broken', url: 'javascript:alert(1)' },
            ],
        };

        const history = await build([
            userRow(1, 'search'),
            toolCallRow(2, [
                builtinToolPart({
                    id: 1,
                    sortOrder: 0,
                    toolId: 'web_search',
                    callId: 'call-1',
                    output: 'results',
                    structuredPayload: sources,
                }),
            ]),
        ]);

        const payload = selectToolCalls(history[1]!)[0]?.structuredPayload;
        expect(payload).toMatchObject({ kind: 'web_search_sources' });
        expect(payload && 'sources' in payload ? payload.sources : []).toHaveLength(1);
    });
});

describe('user reopens a conversation that generated a widget', () => {
    function widgetRow(
        id: number,
        callId: string,
        args: Record<string, unknown>,
        status = 'success'
    ): MessageRow {
        return toolCallRow(id, [
            builtinToolPart({
                id: id * 10,
                sortOrder: 0,
                toolId: 'show_widget',
                callId,
                input: args,
                output: null,
                status,
            }),
        ]);
    }

    it('user sees a generated widget restored in the reply that created it', async () => {
        const history = await build([
            userRow(1, 'draw a chart'),
            widgetRow(2, 'call-1', {
                widgetId: 'w1',
                title: 'Sales',
                description: 'by region',
                widget_code: '<div>chart</div>',
            }),
        ]);

        const widgets = history[1]?.widgets ?? [];
        expect(widgets).toHaveLength(1);
        expect(widgets[0]).toMatchObject({
            widgetId: 'w1',
            title: 'Sales',
            description: 'by region',
            html: '<div>chart</div>',
            phase: 'ready',
        });
        // The widget tool call itself stays out of the visible tool list.
        expect(selectToolCalls(history[1]!)).toHaveLength(0);
        expect(history[1]?.parts.filter((part) => part.type === 'widget')).toHaveLength(1);
    });

    it('user sees the widget removed when a later turn removed it', async () => {
        const history = await build([
            userRow(1, 'draw a chart'),
            widgetRow(2, 'call-1', {
                widgetId: 'w1',
                title: 'Sales',
                widget_code: '<div>chart</div>',
            }),
            userRow(3, 'remove it'),
            widgetRow(4, 'call-2', { widgetId: 'w1', mode: 'remove' }),
        ]);

        expect(history[1]?.widgets ?? []).toHaveLength(0);
        expect(history[1]?.parts.filter((part) => part.type === 'widget')).toHaveLength(0);
    });

    it('user does not see a widget whose generation failed', async () => {
        const history = await build([
            userRow(1, 'draw a chart'),
            widgetRow(
                2,
                'call-1',
                { widgetId: 'w1', title: 'Sales', widget_code: '<div>chart</div>' },
                'error'
            ),
        ]);

        expect(history[1]?.widgets ?? []).toHaveLength(0);
    });
});

describe('user reopens a conversation whose turn was cancelled', () => {
    it('user sees the running tool call marked cancelled and the reply kept', async () => {
        const history = await build(
            [
                userRow(1, 'run it'),
                toolCallRow(2, [
                    textPart(1, 0, 'Working on it'),
                    builtinToolPart({
                        id: 2,
                        sortOrder: 1,
                        toolId: 'bash',
                        callId: 'call-1',
                        status: 'pending',
                    }),
                ]),
            ],
            [
                {
                    id: 1,
                    session_id: 1,
                    task_id: 'task-1',
                    execution_mode: 'foreground',
                    prompt_snapshot_json: '{}',
                    prompt_message_id: 1,
                    response_message_id: 2,
                    status: 'cancelled',
                    error_message: null,
                    created_at: BASE_TIME,
                    updated_at: BASE_TIME,
                } as SessionTurnHistoryRow,
            ]
        );

        const assistant = history[1]!;
        expect(selectToolCalls(assistant)[0]?.status).toBe('cancelled');
        expect(assistant.statusText).toBeTruthy();
    });

    it('user sees a failed turn with nothing visible shown as a failure message', async () => {
        const history = await build(
            [userRow(1, 'run it')],
            [
                {
                    id: 1,
                    session_id: 1,
                    task_id: 'task-1',
                    execution_mode: 'foreground',
                    prompt_snapshot_json: '{}',
                    prompt_message_id: 1,
                    response_message_id: null,
                    status: 'failed',
                    error_message: 'Provider returned 500',
                    created_at: BASE_TIME,
                    updated_at: BASE_TIME,
                } as SessionTurnHistoryRow,
            ]
        );

        expect(history[1]).toMatchObject({ role: 'assistant', isError: true });
        expect(history[1]?.content).toContain('Provider returned 500');
    });

    it('user does not see an error message for a turn that failed without a reason', async () => {
        const history = await build(
            [userRow(1, 'run it'), assistantRow(2, 'done')],
            [
                {
                    id: 1,
                    session_id: 1,
                    task_id: 'task-1',
                    execution_mode: 'foreground',
                    prompt_snapshot_json: '{}',
                    prompt_message_id: 1,
                    response_message_id: 2,
                    status: 'failed',
                    error_message: null,
                    created_at: BASE_TIME,
                    updated_at: BASE_TIME,
                } as SessionTurnHistoryRow,
            ]
        );

        expect(history).toHaveLength(2);
        expect(history[1]?.statusText).toBeUndefined();
    });
});

describe('user reopens a conversation with pasted attachments', () => {
    it('user sees the draft they sent restored with its text and attachments', async () => {
        const history = await build(
            [
                createMessageRow({
                    id: 1,
                    role: 'user',
                    content: 'see attached',
                    attachments: [
                        {
                            id: 9,
                            hash: 'abc',
                            type: 'image',
                            original_name: 'chart.png',
                            origin_path: 'C:/tmp/chart.png',
                            mime_type: 'image/png',
                            size: 12,
                            created_at: BASE_TIME,
                            message_id: 1,
                            sort_order: 0,
                            tool_call_id: null,
                            tool_kind: null,
                        },
                    ],
                }),
            ],
            [
                {
                    id: 1,
                    session_id: 1,
                    task_id: 'task-1',
                    execution_mode: 'foreground',
                    prompt_snapshot_json: JSON.stringify({
                        systemPrompt: '',
                        userPrompt: 'see attached',
                        inputSnapshot: {
                            editorDoc: { type: 'doc', content: [] },
                            excludeFromHistory: true,
                        },
                    }),
                    prompt_message_id: 1,
                    response_message_id: null,
                    status: 'completed',
                    error_message: null,
                    created_at: BASE_TIME,
                    updated_at: BASE_TIME,
                } as SessionTurnHistoryRow,
            ]
        );

        expect(history[0]).toMatchObject({ role: 'user', content: 'see attached' });
        expect(history[0]?.attachments?.[0]?.name).toBe('chart.png');
        expect(history[0]?.inputSnapshot).toMatchObject({
            text: 'see attached',
            excludeFromHistory: true,
            editorDoc: { type: 'doc' },
        });
    });

    it('user sees an unreadable prompt snapshot ignored instead of breaking the conversation', async () => {
        const history = await build(
            [userRow(1, 'hello')],
            [
                {
                    id: 1,
                    session_id: 1,
                    task_id: 'task-1',
                    execution_mode: 'foreground',
                    prompt_snapshot_json: 'not json',
                    prompt_message_id: 1,
                    response_message_id: null,
                    status: 'completed',
                    error_message: null,
                    created_at: BASE_TIME,
                    updated_at: BASE_TIME,
                } as SessionTurnHistoryRow,
            ]
        );

        expect(history[0]).toMatchObject({ role: 'user', content: 'hello' });
        expect(history[0]?.inputSnapshot?.text).toBe('hello');
    });
});

describe('user reopens a conversation whose tool calls ended in different states', () => {
    it.each([
        ['rejected', 'rejected'],
        ['awaiting_approval', 'awaiting_approval'],
        ['approved', 'executing'],
        ['pending', 'executing'],
        ['timeout', 'error'],
        ['cancelled', 'cancelled'],
    ] as const)(
        'user sees a tool call stored as %s restored as %s',
        async (storedStatus, restoredStatus) => {
            const history = await build([
                userRow(1, 'run it'),
                toolCallRow(2, [
                    builtinToolPart({
                        id: 1,
                        sortOrder: 0,
                        toolId: 'bash',
                        callId: 'call-1',
                        status: storedStatus,
                    }),
                ]),
            ]);

            expect(selectToolCalls(history[1]!)[0]?.status).toBe(restoredStatus);
        }
    );

    it('user sees a tool call stored before any status was written restored as completed', async () => {
        const history = await build([
            userRow(1, 'run it'),
            toolCallRow(2, [
                builtinToolPart({
                    id: 1,
                    sortOrder: 0,
                    toolId: 'bash',
                    callId: 'call-1',
                    status: null,
                    output: 'file.txt',
                }),
            ]),
        ]);

        expect(selectToolCalls(history[1]!)[0]).toMatchObject({
            status: 'completed',
            result: 'file.txt',
        });
    });
});

describe('user reopens a conversation whose stored tool data is damaged', () => {
    function rawBashPart(id: number, sortOrder: number, overrides: Record<string, unknown> = {}) {
        return rawBuiltinToolPart(id, sortOrder, {
            toolCallId: 'call-1',
            toolKind: 'builtin',
            tool_id: 'bash',
            input: JSON.stringify({ command: 'dir' }),
            output: null,
            status: 'success',
            duration_ms: null,
            error_message: null,
            approval_state: 'none',
            approval_summary: null,
            conversation_semantic_json: null,
            structured_payload_json: null,
            ...overrides,
        });
    }

    it('user sees a tool call restored without arguments when none were stored', async () => {
        const history = await build([
            userRow(1, 'run it'),
            toolCallRow(2, [rawBashPart(1, 0, { input: null })]),
        ]);

        expect(selectToolCalls(history[1]!)[0]?.arguments).toEqual({});
    });

    it('user sees a tool call restored without arguments when the stored arguments are unreadable', async () => {
        const history = await build([
            userRow(1, 'run it'),
            toolCallRow(2, [rawBashPart(1, 0, { input: '{oops' })]),
        ]);

        expect(selectToolCalls(history[1]!)[0]?.arguments).toEqual({});
    });

    it('user sees the stored summary wording restored instead of the arguments wording', async () => {
        const history = await build([
            userRow(1, 'run it'),
            toolCallRow(2, [
                rawBashPart(1, 0, {
                    conversation_semantic_json: JSON.stringify({
                        action: 'run',
                        target: 'npm test',
                    }),
                }),
            ]),
        ]);

        expect(selectToolCalls(history[1]!)[0]?.builtinConversationSemantic).toEqual({
            action: 'run',
            target: 'npm test',
        });
    });

    it('user sees the summary rebuilt from the arguments when the stored one is unreadable', async () => {
        const history = await build([
            userRow(1, 'run it'),
            toolCallRow(2, [rawBashPart(1, 0, { conversation_semantic_json: '{oops' })]),
        ]);

        expect(selectToolCalls(history[1]!)[0]?.builtinConversationSemantic).toEqual({
            action: 'run',
            target: 'dir',
        });
    });

    it('user sees the summary rebuilt when the stored one names no action', async () => {
        const history = await build([
            userRow(1, 'run it'),
            toolCallRow(2, [
                rawBashPart(1, 0, {
                    conversation_semantic_json: JSON.stringify({ target: 'ignored' }),
                }),
            ]),
        ]);

        expect(selectToolCalls(history[1]!)[0]?.builtinConversationSemantic).toEqual({
            action: 'run',
            target: 'dir',
        });
    });

    it('user sees no sources when the stored search payload is unreadable', async () => {
        const history = await build([
            userRow(1, 'search'),
            toolCallRow(2, [
                rawBashPart(1, 0, {
                    tool_id: 'web_search',
                    structured_payload_json: '{oops',
                }),
            ]),
        ]);

        expect(selectToolCalls(history[1]!)[0]?.structuredPayload).toBeUndefined();
    });

    it('user sees no sources when the stored payload is a different kind', async () => {
        const history = await build([
            userRow(1, 'search'),
            toolCallRow(2, [
                rawBashPart(1, 0, {
                    tool_id: 'web_search',
                    structured_payload_json: JSON.stringify({
                        kind: 'widget_refs',
                        sources: [{ id: 's1', title: 'T', url: 'https://example.test' }],
                    }),
                }),
            ]),
        ]);

        expect(selectToolCalls(history[1]!)[0]?.structuredPayload).toBeUndefined();
    });

    it('user sees no sources when every stored source is unusable', async () => {
        const history = await build([
            userRow(1, 'search'),
            toolCallRow(2, [
                rawBashPart(1, 0, {
                    tool_id: 'web_search',
                    structured_payload_json: JSON.stringify({
                        kind: 'web_search_sources',
                        sources: [{ id: 's1', title: 'T', url: 'file:///etc/passwd' }],
                    }),
                }),
            ]),
        ]);

        expect(selectToolCalls(history[1]!)[0]?.structuredPayload).toBeUndefined();
    });
});

describe('user reopens a conversation whose widget updates are replayed', () => {
    function widgetRow(
        id: number,
        callId: string,
        args: Record<string, unknown>,
        status = 'success'
    ): MessageRow {
        return toolCallRow(id, [
            builtinToolPart({
                id: id * 10,
                sortOrder: 0,
                toolId: 'show_widget',
                callId,
                input: args,
                output: null,
                status,
            }),
        ]);
    }

    it('user sees the widget updated in place when a later turn regenerates it under a new id', async () => {
        const history = await build([
            userRow(1, 'draw a chart'),
            widgetRow(2, 'call-1', {
                widgetId: 'w1',
                title: 'Sales',
                widget_code: '<div>v1</div>',
            }),
            userRow(3, 'make it blue'),
            widgetRow(4, 'call-1', {
                widgetId: 'w2',
                title: 'Sales',
                widget_code: '<div>v2</div>',
            }),
        ]);

        expect(history[1]?.widgets ?? []).toHaveLength(1);
        expect(history[1]?.widgets?.[0]).toMatchObject({
            widgetId: 'w2',
            html: '<div>v2</div>',
        });
        expect(history[3]?.widgets ?? []).toHaveLength(0);
        expect(
            history[1]?.parts.filter((part) => part.type === 'widget').map((part) => part.widgetId)
        ).toEqual(['w2']);
    });

    it('user sees the earlier widget kept when a removal names no widget', async () => {
        const history = await build([
            userRow(1, 'draw a chart'),
            widgetRow(2, 'call-1', {
                widgetId: 'w1',
                title: 'Sales',
                widget_code: '<div>chart</div>',
            }),
            userRow(3, 'remove it'),
            widgetRow(4, 'call-2', { mode: 'remove' }),
        ]);

        expect(history[1]?.widgets?.[0]).toMatchObject({ widgetId: 'w1' });
    });

    it('user does not see a widget whose render carried no markup', async () => {
        const history = await build([
            userRow(1, 'draw a chart'),
            widgetRow(2, 'call-1', { widgetId: 'w1', title: 'Sales' }),
        ]);

        expect(history[1]?.widgets ?? []).toHaveLength(0);
        expect(history[1]?.parts.filter((part) => part.type === 'widget')).toHaveLength(0);
    });

    it('user stays on the same reply when a turn removes a widget that was never shown', async () => {
        const history = await build([
            userRow(1, 'draw a chart'),
            userRow(2, 'remove the ghost'),
            widgetRow(3, 'call-2', { widgetId: 'ghost', mode: 'remove' }),
            assistantRow(4, 'nothing to remove'),
        ]);

        expect(history.map((message) => message.role)).toEqual(['user', 'user', 'assistant']);
        expect(history[2]?.widgets ?? []).toHaveLength(0);
    });

    it('user sees the widget dropped when a later render of the same call failed', async () => {
        const history = await build([
            userRow(1, 'draw a chart'),
            widgetRow(2, 'call-1', {
                widgetId: 'w1',
                title: 'Sales',
                widget_code: '<div>chart</div>',
            }),
            userRow(3, 'try again'),
            widgetRow(4, 'call-1', { widgetId: 'w1', title: 'Sales' }, 'error'),
        ]);

        expect(history[1]?.widgets ?? []).toHaveLength(0);
        expect(history[1]?.parts.filter((part) => part.type === 'widget')).toHaveLength(0);
    });
});

describe('user reopens a conversation that stopped before replying', () => {
    it('user sees a cancelled note when the turn never produced a reply', async () => {
        const history = await build(
            [userRow(1, 'run it')],
            [
                {
                    id: 1,
                    session_id: 1,
                    task_id: 'task-1',
                    execution_mode: 'foreground',
                    prompt_snapshot_json: '{}',
                    prompt_message_id: null,
                    response_message_id: null,
                    status: 'cancelled',
                    error_message: null,
                    created_at: BASE_TIME,
                    updated_at: BASE_TIME,
                } as SessionTurnHistoryRow,
            ]
        );

        expect(history).toHaveLength(2);
        expect(history[1]).toMatchObject({ role: 'assistant', isCancelled: true });
    });

    it('user sees the reply kept and marked cancelled when only a tool call was in flight', async () => {
        const history = await build(
            [
                userRow(1, 'run it'),
                toolCallRow(2, [
                    builtinToolPart({
                        id: 1,
                        sortOrder: 0,
                        toolId: 'bash',
                        callId: 'call-1',
                        status: 'pending',
                    }),
                ]),
            ],
            [
                {
                    id: 1,
                    session_id: 1,
                    task_id: 'task-1',
                    execution_mode: 'foreground',
                    prompt_snapshot_json: '{}',
                    prompt_message_id: 1,
                    response_message_id: 2,
                    status: 'cancelled',
                    error_message: null,
                    created_at: BASE_TIME,
                    updated_at: BASE_TIME,
                } as SessionTurnHistoryRow,
            ]
        );

        expect(history).toHaveLength(2);
        expect(selectToolCalls(history[1]!)[0]?.status).toBe('cancelled');
        expect(history[1]?.statusText).toBeTruthy();
    });

    it('user sees a tool call that already finished left alone by the cancellation', async () => {
        const history = await build(
            [
                userRow(1, 'run both'),
                toolCallRow(2, [
                    builtinToolPart({
                        id: 1,
                        sortOrder: 0,
                        toolId: 'bash',
                        callId: 'call-1',
                        status: 'success',
                        output: 'file.txt',
                    }),
                    builtinToolPart({
                        id: 2,
                        sortOrder: 1,
                        toolId: 'bash',
                        callId: 'call-2',
                        status: 'pending',
                    }),
                ]),
            ],
            [
                {
                    id: 1,
                    session_id: 1,
                    task_id: 'task-1',
                    execution_mode: 'foreground',
                    prompt_snapshot_json: '{}',
                    prompt_message_id: 1,
                    response_message_id: 2,
                    status: 'cancelled',
                    error_message: null,
                    created_at: BASE_TIME,
                    updated_at: BASE_TIME,
                } as SessionTurnHistoryRow,
            ]
        );

        const toolCalls = selectToolCalls(history[1]!);
        expect(toolCalls[0]).toMatchObject({ status: 'completed', result: 'file.txt' });
        expect(toolCalls[1]?.status).toBe('cancelled');
    });

    it('user sees the failure noted beside the reply that already arrived', async () => {
        const history = await build(
            [userRow(1, 'run it'), assistantRow(2, 'partial answer')],
            [
                {
                    id: 1,
                    session_id: 1,
                    task_id: 'task-1',
                    execution_mode: 'foreground',
                    prompt_snapshot_json: '{}',
                    prompt_message_id: 1,
                    response_message_id: null,
                    status: 'failed',
                    error_message: 'Provider returned 500',
                    created_at: BASE_TIME,
                    updated_at: BASE_TIME,
                } as SessionTurnHistoryRow,
            ]
        );

        expect(history).toHaveLength(2);
        expect(history[1]?.content).toBe('partial answer');
        expect(history[1]?.statusText).toContain('Provider returned 500');
    });
});

describe('user reopens a conversation that retried', () => {
    function attempt(
        overrides: Partial<SessionTurnAttemptHistoryRow> = {}
    ): SessionTurnAttemptHistoryRow {
        return {
            id: 1,
            turn_id: 1,
            attempt_index: 1,
            max_retries: 5,
            status: 'failed',
            checkpoint_json: '{}',
            delivery_manifest_json: '{}',
            error_message: null,
            started_at: BASE_TIME,
            finished_at: BASE_TIME,
            created_at: BASE_TIME,
            updated_at: BASE_TIME,
            ...overrides,
        };
    }

    function failedTurn(overrides: Partial<SessionTurnHistoryRow> = {}): SessionTurnHistoryRow {
        return {
            id: 1,
            session_id: 1,
            task_id: 'task-1',
            execution_mode: 'foreground',
            prompt_snapshot_json: '{}',
            prompt_message_id: 1,
            response_message_id: null,
            status: 'failed',
            error_message: null,
            created_at: BASE_TIME,
            updated_at: BASE_TIME,
            ...overrides,
        } as SessionTurnHistoryRow;
    }

    it('user sees the retry note before the reply that the retried attempt produced', async () => {
        const history = await build(
            [userRow(1, 'run it'), assistantRow(2, 'answer')],
            [failedTurn({ prompt_message_id: 1, response_message_id: null })],
            [
                attempt({ id: 1, attempt_index: 1 }),
                attempt({ id: 2, attempt_index: 2, status: 'completed' }),
            ]
        );

        expect(history.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant']);
        expect(history[1]).toMatchObject({ isRetrying: true });
        expect(history[2]).toMatchObject({ content: 'answer' });
    });

    it('user sees the retry note after the last reply when the turn names no messages', async () => {
        const history = await build(
            [userRow(1, 'run it'), assistantRow(2, 'answer')],
            [failedTurn({ prompt_message_id: null, response_message_id: null })],
            [
                attempt({ id: 1, attempt_index: 1 }),
                attempt({ id: 2, attempt_index: 2, status: 'completed' }),
            ]
        );

        expect(history).toHaveLength(3);
        expect(history[2]).toMatchObject({ isRetrying: true });
    });

    it('user sees the retry note alone when the turn left no messages behind', async () => {
        const history = await build(
            [],
            [failedTurn({ prompt_message_id: null, response_message_id: null })],
            [
                attempt({ id: 1, attempt_index: 1 }),
                attempt({ id: 2, attempt_index: 2, status: 'completed' }),
            ]
        );

        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ role: 'assistant', isRetrying: true });
        expect(history[0]?.content).toContain('1/5');
    });
});

describe('user reopens a stored session', () => {
    it('user sees a tool call from a server that is no longer installed named by its id', async () => {
        findAllMcpServersMock.mockResolvedValue([{ id: 7, name: 'filesystem' }]);

        const history = await buildSessionHistoryFromData({
            messages: [
                userRow(1, 'read a file'),
                toolCallRow(2, [
                    mcpToolPart({
                        id: 1,
                        sortOrder: 0,
                        callId: 'call-1',
                        toolName: 'read_file',
                        serverId: 9,
                    }),
                ]),
            ],
            turns: [],
            attempts: [],
        });

        expect(selectToolCalls(history[1]!)[0]?.serverName).toBe('MCP 服务器 9');
    });
});

describe('user reopens a conversation where the model thought before answering', () => {
    function reasoningPart(
        id: number,
        sortOrder: number,
        content: string,
        times: { startedAt?: number | null; endedAt?: number | null } = {}
    ) {
        return createMessagePart({
            id,
            message_id: 2,
            type: 'reasoning',
            content,
            sort_order: sortOrder,
            started_at: times.startedAt ?? null,
            ended_at: times.endedAt ?? null,
        });
    }

    it('user sees the thinking shown before the answer it produced', async () => {
        const history = await build([
            userRow(1, 'why is the sky blue?'),
            assistantRow(2, 'because of scattering'),
            toolCallRow(3, [
                reasoningPart(1, 0, 'light scatters'),
                { ...textPart(2, 1, 'because of scattering') },
            ]),
        ]);

        // The stored assistant row wins over the trailing text of the tool_call row.
        expect(history[1]?.reasoning).toBe('light scatters');
        expect(history[1]?.parts.map((part) => part.type)).toEqual(['text', 'reasoning']);
    });

    it('user sees the thinking kept when the reply holds no text', async () => {
        const history = await build([
            userRow(1, 'work it out'),
            createMessageRow({
                id: 2,
                role: 'assistant',
                parts: [reasoningPart(1, 0, 'thinking only')],
            }),
        ]);

        expect(history[1]?.content).toBe('');
        expect(history[1]?.reasoning).toBe('thinking only');
        expect(history[1]?.parts).toEqual([
            expect.objectContaining({ type: 'reasoning', content: 'thinking only' }),
        ]);
    });

    it('user sees the thinking time kept from the stored timestamps', async () => {
        const startedAt = parseDbDateTimestamp('2026-05-22T10:00:00.000Z');
        const endedAt = parseDbDateTimestamp('2026-05-22T10:00:04.000Z');

        const history = await build([
            userRow(1, 'work it out'),
            createMessageRow({
                id: 2,
                role: 'assistant',
                parts: [reasoningPart(1, 0, 'thinking', { startedAt, endedAt })],
            }),
        ]);

        expect(history[1]?.parts[0]).toMatchObject({ startedAt, endedAt });
    });

    it('user sees an interrupted thinking block timed up to its last saved moment', async () => {
        const startedAt = parseDbDateTimestamp('2026-05-22T10:00:00.000Z');
        const updatedAt = parseDbDateTimestamp('2026-05-22T10:00:07.000Z');

        const history = await build([
            userRow(1, 'work it out'),
            createMessageRow({
                id: 2,
                role: 'assistant',
                parts: [
                    createMessagePart({
                        id: 1,
                        message_id: 2,
                        type: 'reasoning',
                        content: 'cut short',
                        sort_order: 0,
                        started_at: startedAt,
                        ended_at: null,
                        updated_at: '2026-05-22T10:00:07.000Z',
                    }),
                ],
            }),
        ]);

        expect(history[1]?.parts[0]).toMatchObject({ startedAt, endedAt: updatedAt });
    });

    it('user sees no timing on a thinking block that never started', async () => {
        const history = await build([
            userRow(1, 'work it out'),
            createMessageRow({
                id: 2,
                role: 'assistant',
                parts: [reasoningPart(1, 0, 'untimed', { startedAt: null, endedAt: null })],
            }),
        ]);

        const part = history[1]?.parts[0] as { startedAt?: number; endedAt?: number };
        expect(part.startedAt).toBeUndefined();
        expect(part.endedAt).toBeUndefined();
    });

    it('user sees an empty stored text piece left out of the reply', async () => {
        const history = await build([
            userRow(1, 'hello'),
            createMessageRow({
                id: 2,
                role: 'assistant',
                parts: [textPart(1, 0, ''), textPart(2, 1, 'hi')],
            }),
        ]);

        expect(history[1]?.content).toBe('hi');
        expect(history[1]?.parts).toHaveLength(1);
    });
});
