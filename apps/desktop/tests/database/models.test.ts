import { setDefaultModel } from '@database/queries/models';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { getTauriInvokeCalls, interceptTauriInvoke } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

function getRequest(payload: InvokeArgs | undefined) {
    return (payload as { request?: { sql: string; params?: unknown[]; method: string } })?.request;
}

describe('model database queries', () => {
    it('switches the default model without emitting a CASE update through sqlite-proxy', async () => {
        interceptTauriInvoke((call) => {
            if (call.cmd === 'database_tx_begin') {
                return 'tx_issue_72';
            }

            if (call.cmd === 'database_tx_commit' || call.cmd === 'database_tx_rollback') {
                return undefined;
            }

            if (call.cmd === 'database_tx_query') {
                const request = getRequest(call.payload);

                if (request?.method === 'get') {
                    return {
                        rows: [{ id: 211, enabled: 1, provider_name: 'OpenAI' }],
                        rowsAffected: 0,
                        lastInsertId: null,
                    };
                }

                if (request?.sql.toLowerCase().includes('case when')) {
                    throw new Error(
                        `Failed query: ${request.sql} params: ${(request.params ?? []).join(',')}`
                    );
                }

                return { rows: [], rowsAffected: 1, lastInsertId: null };
            }

            return undefined;
        });

        await expect(setDefaultModel({ modelId: 211 })).resolves.toBeUndefined();

        const updateQueries = getTauriInvokeCalls('database_tx_query')
            .map((call) => getRequest(call.payload))
            .filter((request) => request?.method === 'run');

        expect(updateQueries).toHaveLength(2);
        expect(updateQueries.map((request) => request?.sql.toLowerCase())).toEqual([
            expect.stringContaining(
                'update "models" set "is_default" = ? where "models"."is_default" = ?'
            ),
            expect.stringContaining('update "models" set "is_default" = ? where "models"."id" = ?'),
        ]);
        expect(updateQueries.map((request) => request?.params)).toEqual([
            [0, 1],
            [1, 211],
        ]);
    });
});
