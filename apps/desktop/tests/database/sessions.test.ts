import { refreshSessionMetadata } from '@database/queries/sessions';
import { listSessions } from '@database/queries/sessions';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { getTauriInvokeCalls, interceptTauriInvoke } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

function getRequest(payload: InvokeArgs | undefined) {
    return (payload as { request?: { sql: string; params?: unknown[]; method: string } })?.request;
}

describe('when a conversation records its model', () => {
    it('user keeps the provider they picked before the first message is sent', async () => {
        interceptTauriInvoke((call) => {
            if (call.cmd === 'database_query') {
                return { rows: [], rowsAffected: 1, lastInsertId: null };
            }

            return undefined;
        });

        await expect(refreshSessionMetadata(17)).resolves.toBeUndefined();

        const request = getTauriInvokeCalls('database_query')
            .map((call) => getRequest(call.payload))
            .find((candidate) => candidate?.method === 'run');
        const normalizedSql = request?.sql.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';

        expect(normalizedSql).toContain('"provider_id" = coalesce((');
        expect(normalizedSql).toContain('from "session_turns" "latest_turns"');
        expect(normalizedSql).toContain('"sessions"."provider_id"');
        expect(normalizedSql).not.toContain('"provider_id" = (select');
    });

    it('narrows session content search with multiple necessary trigrams', async () => {
        interceptTauriInvoke((call) => {
            if (call.cmd === 'database_query') {
                return { rows: [], rowsAffected: 0, lastInsertId: null };
            }

            return undefined;
        });

        await listSessions({ query: 'abcdefghi', limit: 40 });

        const searchRequest = getTauriInvokeCalls('database_query')
            .map((call) => getRequest(call.payload))
            .find((candidate) => candidate?.sql.includes('message_search_fts'));

        expect(searchRequest).toBeDefined();
        expect(searchRequest!.params).toContain('"abc" AND "def" AND "ghi"');
    });
});
