import { findMessagesBySessionId } from '@database/queries/messages';
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
});
