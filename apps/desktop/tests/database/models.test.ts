import { recordUpstreamModelMetadata, setDefaultModel } from '@database/queries/models';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { getTauriInvokeCalls, interceptTauriInvoke } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

function getRequest(payload: InvokeArgs | undefined) {
    return (payload as { request?: { sql: string; params?: unknown[]; method: string } })?.request;
}

describe('when the app changes which model is in use', () => {
    it('user gets exactly one default model after switching', async () => {
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

    it('user keeps their own model edits while refreshing a provider', async () => {
        interceptTauriInvoke((call) => {
            if (call.cmd === 'database_query') {
                return { rows: [], rowsAffected: 1, lastInsertId: null };
            }

            return undefined;
        });

        await expect(
            recordUpstreamModelMetadata({
                providerId: 7,
                entries: [
                    {
                        model_id: 'group/auto-gpt-5-6-sol',
                        metadata: { context_limit: 400_000, reasoning: 1 },
                    },
                ],
            })
        ).resolves.toBeUndefined();

        const request = getTauriInvokeCalls('database_query')
            .map((call) => getRequest(call.payload))
            .find((candidate) => candidate?.method === 'run');
        const normalizedSql = request?.sql.replace(/\s+/g, ' ').trim() ?? '';

        expect(normalizedSql).toContain('FROM json_each(?) AS entry');
        expect(normalizedSql).toContain(
            "upstream_metadata = json_patch( COALESCE(upstream_metadata, '{}'), COALESCE(("
        );
        // 元数据列只由 syncAllModelsMetadata 重建，这里不重复写列。
        expect(normalizedSql).not.toContain('context_limit =');
        expect(normalizedSql).toContain('AND is_custom_metadata = 0');
        expect(request?.params).toEqual([
            JSON.stringify([
                {
                    model_id: 'group/auto-gpt-5-6-sol',
                    metadata: { context_limit: 400_000, reasoning: 1 },
                },
            ]),
            7,
        ]);
    });

    it('user gets no upstream record written when the provider declares nothing', async () => {
        interceptTauriInvoke((call) => {
            if (call.cmd === 'database_query') {
                return { rows: [], rowsAffected: 1, lastInsertId: null };
            }

            return undefined;
        });

        await expect(
            recordUpstreamModelMetadata({ providerId: 7, entries: [] })
        ).resolves.toBeUndefined();

        expect(getTauriInvokeCalls('database_query')).toHaveLength(0);
    });
});
