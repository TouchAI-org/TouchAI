/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import type { MessageRow } from '@database/queries/messages';
import type { SessionTurnAttemptHistoryRow } from '@database/queries/sessionTurnAttempts';
import type { SessionTurnHistoryRow } from '@database/queries/sessionTurns';
import { createMessagePart, createMessageRow } from '@tests/utils/messages';
import { describe, expect, it, vi } from 'vitest';

import { buildSessionHistory } from '@/services/AgentService/session/history';
import { selectToolCalls } from '@/utils/session';

/**
 * Complements history.test.ts with turns that point at messages which are no longer in the
 * loaded history, and with turns whose attempts never recorded a finish time.
 *
 * Why these matter: a turn row outlives its messages when a message is pruned or when the
 * page loads a window of history. Losing the anchor must degrade to "put the note at the
 * end", never throw and never drop the whole conversation.
 */
vi.mock('@database/queries/mcpServers', () => ({
    findAllMcpServers: vi.fn(async () => []),
}));

const BASE_TIME = '2026-05-22T10:00:00.000Z';

function userRow(id: number, content: string): MessageRow {
    return createMessageRow({ id, role: 'user', content });
}

function assistantRow(id: number, content: string): MessageRow {
    return createMessageRow({ id, role: 'assistant', content });
}

function createTurn(overrides: Partial<SessionTurnHistoryRow> = {}): SessionTurnHistoryRow {
    return {
        id: 1,
        session_id: 1,
        task_id: 'task-1',
        execution_mode: 'foreground',
        prompt_snapshot_json: '{}',
        prompt_message_id: null,
        response_message_id: null,
        status: 'completed',
        error_message: null,
        created_at: BASE_TIME,
        updated_at: BASE_TIME,
        ...overrides,
    } as SessionTurnHistoryRow;
}

function createAttempt(
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

async function build(
    messages: MessageRow[],
    turns: SessionTurnHistoryRow[] = [],
    attempts: SessionTurnAttemptHistoryRow[] = []
) {
    return buildSessionHistory({ messages, turns, attempts, resolveServerName: () => '' });
}

describe('user reopens a conversation whose turn points at a deleted reply', () => {
    it('user sees the failure noted on the last reply instead of losing it', async () => {
        const history = await build(
            [userRow(1, 'run it'), assistantRow(2, 'the answer')],
            [
                createTurn({
                    status: 'failed',
                    error_message: 'Provider returned 500',
                    prompt_message_id: 1,
                    // The reply this turn referred to is no longer loaded.
                    response_message_id: 999,
                }),
            ]
        );

        expect(history).toHaveLength(2);
        expect(history[1]?.content).toBe('the answer');
        expect(history[1]?.statusText).toContain('Provider returned 500');
    });

    it('user sees a cancellation noted on the last reply when its message is gone', async () => {
        const history = await build(
            [userRow(1, 'run it'), assistantRow(2, 'partial')],
            [createTurn({ status: 'cancelled', response_message_id: 999 })]
        );

        expect(history[1]?.statusText).toBeTruthy();
        expect(history).toHaveLength(2);
    });

    it('user sees the retry note added after the conversation when its reply is gone', async () => {
        const history = await build(
            [userRow(1, 'run it'), assistantRow(2, 'the answer')],
            [createTurn({ status: 'failed', response_message_id: 999 })],
            [createAttempt({ id: 1, attempt_index: 1 }), createAttempt({ id: 2, attempt_index: 2 })]
        );

        // With no surviving anchor the note lands at the end, after everything else.
        expect(history.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant']);
        expect(history[2]).toMatchObject({ isRetrying: true });
    });
});

describe('user reopens a conversation whose turn points at a deleted prompt', () => {
    it('user sees the failure noted on the last reply when nothing else anchors it', async () => {
        const history = await build(
            [userRow(1, 'kept'), assistantRow(2, 'reply')],
            [
                createTurn({
                    status: 'failed',
                    error_message: 'offline',
                    // Both anchors are gone, so the note falls back to the last message.
                    prompt_message_id: 999,
                    response_message_id: 998,
                }),
            ]
        );

        expect(history).toHaveLength(2);
        expect(history[1]?.content).toBe('reply');
        expect(history[1]?.statusText).toContain('offline');
    });

    it('user sees a separate failure note when the last message has nothing visible', async () => {
        const history = await build(
            [userRow(1, 'kept')],
            [
                createTurn({
                    status: 'failed',
                    error_message: 'offline',
                    prompt_message_id: 999,
                    response_message_id: 998,
                }),
            ]
        );

        // The last message is the prompt itself, which cannot carry a status line.
        expect(history).toHaveLength(2);
        expect(history[1]).toMatchObject({ role: 'assistant', isError: true });
        expect(history[1]?.content).toContain('offline');
    });

    it('user sees the retry note added at the end when no prompt anchors it', async () => {
        const history = await build(
            [userRow(1, 'kept'), assistantRow(2, 'reply')],
            [createTurn({ status: 'failed', prompt_message_id: 999 })],
            [createAttempt({ id: 1, attempt_index: 1 }), createAttempt({ id: 2, attempt_index: 2 })]
        );

        expect(history).toHaveLength(3);
        expect(history[2]).toMatchObject({ isRetrying: true });
    });

    it('user sees the retry note alone when the conversation has no messages left', async () => {
        const history = await build(
            [],
            [createTurn({ status: 'failed', prompt_message_id: 999 })],
            [createAttempt({ id: 1, attempt_index: 1 }), createAttempt({ id: 2, attempt_index: 2 })]
        );

        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ role: 'assistant', isRetrying: true });
    });
});

describe('user reopens a conversation whose retry never finished', () => {
    it('user sees the retry note timed by when the attempt was last touched', async () => {
        const history = await build(
            [userRow(1, 'run it'), assistantRow(2, 'answer')],
            [createTurn({ status: 'failed', prompt_message_id: 1 })],
            [
                createAttempt({
                    id: 1,
                    attempt_index: 1,
                    // The attempt was interrupted, so it has no finish time.
                    finished_at: null,
                    updated_at: '2026-05-22T10:00:05.000Z',
                }),
                createAttempt({ id: 2, attempt_index: 2, status: 'completed' }),
            ]
        );

        const retry = history.find((message) => message.isRetrying);
        expect(retry).toBeDefined();
        expect(retry?.timestamp).toBeGreaterThan(0);
    });

    it('user sees the retry note still timed when only the start was recorded', async () => {
        const history = await build(
            [userRow(1, 'run it'), assistantRow(2, 'answer')],
            [createTurn({ status: 'failed', prompt_message_id: 1 })],
            [
                createAttempt({
                    id: 1,
                    attempt_index: 1,
                    finished_at: null,
                    updated_at: null,
                } as never),
                createAttempt({ id: 2, attempt_index: 2, status: 'completed' }),
            ]
        );

        const retry = history.find((message) => message.isRetrying);
        expect(retry).toBeDefined();
    });
});

describe('user reopens a conversation where a tool call ended in a cancelled state', () => {
    function toolCallRow(id: number, status: string, output: string | null): MessageRow {
        return createMessageRow({
            id,
            role: 'tool_call',
            parts: [
                createMessagePart({
                    id: id * 10,
                    message_id: id,
                    type: 'tool_call',
                    content: '',
                    sort_order: 0,
                    tool_call_id: 'call-1',
                    tool_kind: 'builtin',
                    data: JSON.stringify({
                        toolCallId: 'call-1',
                        toolKind: 'builtin',
                        tool_id: 'bash',
                        input: JSON.stringify({ command: 'dir' }),
                        output,
                        status,
                        duration_ms: 12,
                        error_message: null,
                        approval_state: 'none',
                        approval_summary: null,
                        conversation_semantic_json: null,
                        structured_payload_json: null,
                    }),
                }),
            ],
        });
    }

    it('user sees a tool call stored as rejected restored as rejected', async () => {
        const history = await build([userRow(1, 'run it'), toolCallRow(2, 'rejected', null)]);

        expect(selectToolCalls(history[1]!)[0]).toMatchObject({
            status: 'rejected',
            isError: false,
        });
    });

    it('user sees a tool call awaiting approval restored as still waiting', async () => {
        const history = await build([
            userRow(1, 'run it'),
            toolCallRow(2, 'awaiting_approval', null),
        ]);

        expect(selectToolCalls(history[1]!)[0]?.status).toBe('awaiting_approval');
    });

    it('user sees a tool call stored as approved restored as still running', async () => {
        const history = await build([userRow(1, 'run it'), toolCallRow(2, 'approved', null)]);

        expect(selectToolCalls(history[1]!)[0]?.status).toBe('executing');
    });

    it('user sees a timed-out tool call restored as an error', async () => {
        const history = await build([userRow(1, 'run it'), toolCallRow(2, 'timeout', 'timed out')]);

        expect(selectToolCalls(history[1]!)[0]).toMatchObject({
            status: 'error',
            isError: true,
        });
    });
});

describe('user reopens a conversation with a widget that was updated in place', () => {
    function widgetRow(
        id: number,
        callId: string,
        args: Record<string, unknown>,
        status = 'success'
    ): MessageRow {
        return createMessageRow({
            id,
            role: 'tool_call',
            parts: [
                createMessagePart({
                    id: id * 10,
                    message_id: id,
                    type: 'tool_call',
                    content: '',
                    sort_order: 0,
                    tool_call_id: callId,
                    tool_kind: 'builtin',
                    data: JSON.stringify({
                        toolCallId: callId,
                        toolKind: 'builtin',
                        tool_id: 'show_widget',
                        input: JSON.stringify(args),
                        output: null,
                        status,
                        duration_ms: null,
                        error_message: null,
                        approval_state: 'none',
                        approval_summary: null,
                        conversation_semantic_json: null,
                        structured_payload_json: null,
                    }),
                }),
            ],
        });
    }

    it('user sees the widget regenerated in place when only its id matches', async () => {
        const history = await build([
            userRow(1, 'draw a chart'),
            widgetRow(2, 'call-1', {
                widgetId: 'w1',
                title: 'Sales',
                widget_code: '<div>v1</div>',
            }),
            userRow(3, 'update it'),
            widgetRow(4, 'call-2', {
                widgetId: 'w1',
                title: 'Sales',
                widget_code: '<div>v2</div>',
            }),
        ]);

        expect(history[1]?.widgets?.[0]).toMatchObject({
            widgetId: 'w1',
            html: '<div>v2</div>',
        });
        // The widget lives in the reply that first created it.
        expect(history[3]?.widgets ?? []).toHaveLength(0);
    });

    it('user sees the widget removed by call id when a later turn failed on the same call', async () => {
        const history = await build([
            userRow(1, 'draw a chart'),
            widgetRow(2, 'call-1', {
                widgetId: 'w1',
                title: 'Sales',
                widget_code: '<div>chart</div>',
            }),
            userRow(3, 'regenerate'),
            widgetRow(4, 'call-1', { widgetId: 'w1', title: 'Sales' }, 'error'),
        ]);

        expect(history[1]?.widgets ?? []).toHaveLength(0);
    });

    it('user sees the widget titled by its id when the model gave no title', async () => {
        const history = await build([
            userRow(1, 'draw a chart'),
            widgetRow(2, 'call-1', { widgetId: 'chart-9', widget_code: '<div>chart</div>' }),
        ]);

        expect(history[1]?.widgets?.[0]).toMatchObject({
            widgetId: 'chart-9',
            title: 'chart-9',
        });
    });

    it('user sees the widget accepted when the model wrote its markup under html', async () => {
        const history = await build([
            userRow(1, 'draw a chart'),
            widgetRow(2, 'call-1', { widgetId: 'w1', title: 'Sales', html: '<div>legacy</div>' }),
        ]);

        expect(history[1]?.widgets?.[0]).toMatchObject({ html: '<div>legacy</div>' });
    });
});
