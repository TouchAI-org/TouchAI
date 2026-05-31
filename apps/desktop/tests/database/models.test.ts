import { setDefaultModel, syncAllModelsMetadata } from '@database/queries/models';
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

    it('does not sync metadata from unrelated prefix model ids', async () => {
        interceptTauriInvoke((call) => {
            if (call.cmd === 'database_query') {
                return { rows: [], rowsAffected: 1, lastInsertId: null };
            }

            return undefined;
        });

        await expect(syncAllModelsMetadata()).resolves.toBeUndefined();

        const request = getTauriInvokeCalls('database_query')
            .map((call) => getRequest(call.payload))
            .find((candidate) => candidate?.method === 'run');
        const normalizedSql = request?.sql.replace(/\s+/g, ' ').trim() ?? '';

        expect(normalizedSql).toContain(
            'CASE WHEN lower(m2.model_id) = lower(models.model_id) THEN 1 ELSE 0 END DESC'
        );
        expect(normalizedSql).toContain(
            "substr(m2.model_id, length(models.model_id) + 1) GLOB '-[0-9][0-9][0-9][0-9]'"
        );
        expect(normalizedSql).toContain(
            "lower(substr(m2.model_id, length(models.model_id) + 1)) = '-latest'"
        );
        expect(normalizedSql).not.toContain(
            "lower(m2.model_id) LIKE '%' || lower(models.model_id) || '%'"
        );
    });
});
