import { findMessagesBySessionId, findMessagesPageBySessionId } from '@database/queries/messages';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { createMessagePart, MESSAGE_TIME } from '@tests/utils/messages';
import { getTauriInvokeCalls, interceptTauriInvoke } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

function request(payload: InvokeArgs | undefined) {
    return (payload as { request: { sql: string } }).request;
}

describe('when the user reopens a conversation', () => {
    it('user sees each message once with all its tool calls', async () => {
        const row = {
            id: 11,
            session_id: 1,
            role: 'tool_call',
            created_at: MESSAGE_TIME,
            updated_at: MESSAGE_TIME,
        };
        const parts = ['call_1', 'call_2'].map((callId, index) =>
            createMessagePart({
                id: index + 1,
                message_id: 11,
                type: 'tool_call',
                sort_order: index,
                data: JSON.stringify({
                    toolCallId: callId,
                    toolKind: 'builtin',
                    tool_id: 'bash',
                    input: '{}',
                }),
            })
        );
        interceptTauriInvoke((call) => {
            if (call.cmd !== 'database_query') return undefined;
            const sql = request(call.payload).sql;
            const rows = sql.includes('from "messages"')
                ? [row]
                : sql.includes('from "message_parts"') && !sql.includes('join')
                  ? parts
                  : [];
            return { rows, rowsAffected: 0, lastInsertId: null };
        });
        expect(await findMessagesBySessionId(1)).toEqual([{ ...row, parts, attachments: [] }]);
        const queries = getTauriInvokeCalls('database_query').map(
            (call) => request(call.payload).sql
        );
        expect(queries).toHaveLength(3);
        expect(queries.every((sql) => !sql.includes('"tool_kind" ='))).toBe(true);
    });

    it('user gets an empty conversation without extra lookups', async () => {
        interceptTauriInvoke((call) =>
            call.cmd === 'database_query'
                ? { rows: [], rowsAffected: 0, lastInsertId: null }
                : undefined
        );
        expect(await findMessagesBySessionId(99)).toEqual([]);
        expect(getTauriInvokeCalls('database_query')).toHaveLength(1);
    });

    it('returns the newest page in ascending order and reports earlier messages', async () => {
        const rows = [
            {
                id: 3,
                session_id: 1,
                role: 'assistant',
                created_at: MESSAGE_TIME,
                updated_at: MESSAGE_TIME,
            },
            {
                id: 2,
                session_id: 1,
                role: 'user',
                created_at: MESSAGE_TIME,
                updated_at: MESSAGE_TIME,
            },
            {
                id: 1,
                session_id: 1,
                role: 'user',
                created_at: MESSAGE_TIME,
                updated_at: MESSAGE_TIME,
            },
        ];
        interceptTauriInvoke((call) => {
            if (call.cmd !== 'database_query') return undefined;
            const sql = request(call.payload).sql;
            if (sql.includes('from "messages"')) {
                return { rows, rowsAffected: 0, lastInsertId: null };
            }
            return { rows: [], rowsAffected: 0, lastInsertId: null };
        });

        const page = await findMessagesPageBySessionId(1, { limit: 2 });

        // 多取一条用于判断 hasMore，返回时只保留最新两页并恢复升序。
        expect(page.hasMore).toBe(true);
        expect(page.messages.map((message) => message.id)).toEqual([2, 3]);
        const messageSql = getTauriInvokeCalls('database_query').map(
            (call) => request(call.payload).sql
        )[0]!;
        expect(messageSql).toContain('order by "messages"."id" desc');
        expect(messageSql).toContain('limit');
    });

    it('uses beforeMessageId as a strict cursor for older pages', async () => {
        interceptTauriInvoke((call) =>
            call.cmd === 'database_query'
                ? { rows: [], rowsAffected: 0, lastInsertId: null }
                : undefined
        );

        const page = await findMessagesPageBySessionId(1, { limit: 2, beforeMessageId: 10 });

        expect(page).toEqual({ messages: [], hasMore: false });
        const messageSql = getTauriInvokeCalls('database_query').map(
            (call) => request(call.payload).sql
        )[0]!;
        expect(messageSql).toContain('"messages"."id" <');
    });
});
