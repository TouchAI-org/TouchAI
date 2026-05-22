import type { MessageRow } from '@database/queries/messages';
import type { SessionTurnAttemptHistoryRow } from '@database/queries/sessionTurnAttempts';
import type { SessionTurnHistoryRow } from '@database/queries/sessionTurns';
import { describe, expect, it } from 'vitest';

import { buildSessionHistory } from '@/services/AgentService/session/history';

const COMPLETED_TEXT = '\u4efb\u52a1\u5df2\u5b8c\u6210';
const FAILED_TEXT = '\u4efb\u52a1\u5931\u8d25\uff1anetwork error';
const WAITING_APPROVAL_TEXT = '\u4efb\u52a1\u6b63\u5728\u7b49\u5f85\u6279\u51c6';
const REQUEST_FAILED_STATUS_TEXT = '\u8bf7\u6c42\u5931\u8d25: network error';

function createMessageRow(
    overrides: Partial<MessageRow> & Pick<MessageRow, 'id' | 'role' | 'content'>
): MessageRow {
    return {
        id: overrides.id,
        session_id: 1,
        role: overrides.role,
        content: overrides.content,
        reasoning: null,
        tool_log_id: null,
        tool_log_kind: null,
        created_at: '2026-05-21 10:00:00',
        updated_at: '2026-05-21 10:00:00',
        attachments: [],
        tool_call_id: null,
        tool_name: null,
        tool_input: null,
        tool_log_ref_id: null,
        tool_status: null,
        tool_duration_ms: null,
        server_id: null,
        ...overrides,
    };
}

function createTurn(
    overrides: Partial<SessionTurnHistoryRow> & Pick<SessionTurnHistoryRow, 'id' | 'status'>
): SessionTurnHistoryRow {
    return {
        id: overrides.id,
        session_id: 1,
        task_id: `task-${overrides.id}`,
        execution_mode: 'foreground',
        prompt_snapshot_json: JSON.stringify({
            id: `snapshot-${overrides.id}`,
            createdAt: '2026-05-21T10:00:00.000Z',
            executionMode: 'foreground',
            fragments: [],
            userPrompt: 'hello',
            attachments: [],
            systemPrompt: '',
        }),
        prompt_message_id: null,
        response_message_id: null,
        status: overrides.status,
        error_message: null,
        created_at: '2026-05-21 10:00:00',
        updated_at: '2026-05-21 10:00:01',
        ...overrides,
    };
}

describe('buildSessionHistory status reminders', () => {
    it('rebuilds a completed system reminder from turn status', async () => {
        const history = await buildSessionHistory({
            messages: [
                createMessageRow({
                    id: 1,
                    role: 'user',
                    content: 'hello',
                }),
                createMessageRow({
                    id: 2,
                    role: 'assistant',
                    content: 'done',
                }),
            ],
            turns: [
                createTurn({
                    id: 1,
                    status: 'completed',
                    prompt_message_id: 1,
                    response_message_id: 2,
                }),
            ],
            attempts: [],
            resolveServerName: () => 'MCP',
        });

        expect(history.map((message) => [message.role, message.content])).toEqual([
            ['user', 'hello'],
            ['assistant', 'done'],
            ['system', COMPLETED_TEXT],
        ]);
    });

    it('rebuilds a failed system reminder from turn status', async () => {
        const history = await buildSessionHistory({
            messages: [
                createMessageRow({
                    id: 1,
                    role: 'user',
                    content: 'hello',
                }),
                createMessageRow({
                    id: 2,
                    role: 'assistant',
                    content: 'partial answer',
                }),
            ],
            turns: [
                createTurn({
                    id: 1,
                    status: 'failed',
                    error_message: 'network error',
                    prompt_message_id: 1,
                    response_message_id: 2,
                }),
            ],
            attempts: [] as SessionTurnAttemptHistoryRow[],
            resolveServerName: () => 'MCP',
        });

        expect(
            history.some((message) => message.role === 'system' && message.content === FAILED_TEXT)
        ).toBe(true);
        expect(history.find((message) => message.role === 'assistant')?.statusText).toBe(
            REQUEST_FAILED_STATUS_TEXT
        );
    });

    it('rebuilds a waiting-approval system reminder from tool status', async () => {
        const history = await buildSessionHistory({
            messages: [
                createMessageRow({
                    id: 1,
                    role: 'user',
                    content: 'hello',
                }),
                createMessageRow({
                    id: 2,
                    role: 'tool_call',
                    content: '',
                    tool_call_id: 'call-1',
                    tool_name: 'builtin__bash',
                    tool_input: '{}',
                    tool_status: 'awaiting_approval',
                }),
            ],
            turns: [],
            attempts: [],
            resolveServerName: () => 'MCP',
        });

        expect(history.map((message) => [message.role, message.content])).toEqual([
            ['user', 'hello'],
            ['assistant', ''],
            ['system', WAITING_APPROVAL_TEXT],
        ]);
        expect(history[1]?.toolCalls?.[0]?.status).toBe('awaiting_approval');
    });

    it('does not duplicate a completed reminder already persisted in history', async () => {
        const history = await buildSessionHistory({
            messages: [
                createMessageRow({
                    id: 1,
                    role: 'user',
                    content: 'hello',
                }),
                createMessageRow({
                    id: 2,
                    role: 'assistant',
                    content: 'done',
                }),
                createMessageRow({
                    id: 3,
                    role: 'system',
                    content: COMPLETED_TEXT,
                }),
            ],
            turns: [
                createTurn({
                    id: 1,
                    status: 'completed',
                    prompt_message_id: 1,
                    response_message_id: 2,
                }),
            ],
            attempts: [],
            resolveServerName: () => 'MCP',
        });

        expect(
            history.filter(
                (message) => message.role === 'system' && message.content === COMPLETED_TEXT
            )
        ).toHaveLength(1);
    });

    it('does not duplicate a waiting-approval reminder already persisted in history', async () => {
        const history = await buildSessionHistory({
            messages: [
                createMessageRow({
                    id: 1,
                    role: 'user',
                    content: 'hello',
                }),
                createMessageRow({
                    id: 2,
                    role: 'tool_call',
                    content: '',
                    tool_call_id: 'call-1',
                    tool_name: 'builtin__bash',
                    tool_input: '{}',
                    tool_status: 'awaiting_approval',
                }),
                createMessageRow({
                    id: 3,
                    role: 'system',
                    content: WAITING_APPROVAL_TEXT,
                }),
            ],
            turns: [],
            attempts: [],
            resolveServerName: () => 'MCP',
        });

        expect(
            history.filter(
                (message) => message.role === 'system' && message.content === WAITING_APPROVAL_TEXT
            )
        ).toHaveLength(1);
    });
});
