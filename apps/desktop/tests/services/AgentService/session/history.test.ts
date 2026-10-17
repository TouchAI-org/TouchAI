import type { MessageRow } from '@database/queries/messages';
import type { SessionTurnAttemptHistoryRow } from '@database/queries/sessionTurnAttempts';
import type { SessionTurnHistoryRow } from '@database/queries/sessionTurns';
import { describe, expect, it, vi } from 'vitest';

import { buildSessionHistoryFromData } from '@/services/AgentService/session/history';
import { parseDbDateTimestamp } from '@/utils/date';
import { selectToolCalls } from '@/utils/session';

const { findAllMcpServersMock } = vi.hoisted(() => ({
    findAllMcpServersMock: vi.fn(),
}));

vi.mock('@database/queries/mcpServers', () => ({
    findAllMcpServers: findAllMcpServersMock,
}));

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

describe('buildSessionHistoryFromData', () => {
    it('restores builtin tool call startedAt from the persisted tool log timestamp', async () => {
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
