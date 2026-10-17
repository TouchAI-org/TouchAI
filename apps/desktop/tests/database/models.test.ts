import {
    applyUpstreamModelMetadata,
    setDefaultModel,
    syncAllModelsMetadata,
} from '@database/queries/models';
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

    it('matches runtime model ids through the alias table instead of prefix LIKE scans', async () => {
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

        expect(normalizedSql).toContain('WITH RECURSIVE candidate_model_ids');
        expect(normalizedSql).toContain(
            'JOIN llm_metadata_aliases AS alias_map ON alias_map.alias = candidate_model_ids.candidate'
        );
        expect(normalizedSql).toContain('match_depth ASC');
        expect(normalizedSql).not.toContain('LIKE');
    });

    it('strips gateway namespaces and auto/any prefixes before alias matching', async () => {
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

        // 命名空间与前缀裁剪必须是独立的递归分支：CASE 每层只能裁一次，
        // 否则 `workbuddy-ai/step-5-preview` 这类 id 永远走不到命名空间裁剪。
        expect(normalizedSql).toContain(
            "substr(candidate_model_ids.candidate, instr(candidate_model_ids.candidate, '/') + 1)"
        );
        expect(normalizedSql).toContain(
            "FROM candidate_model_ids WHERE candidate_model_ids.depth < 6 AND instr(candidate_model_ids.candidate, '/') > 1"
        );
        expect(normalizedSql).toContain(
            "substr(candidate_model_ids.candidate, 6), candidate_model_ids.depth + 1 FROM candidate_model_ids WHERE candidate_model_ids.depth < 6 AND candidate_model_ids.candidate GLOB 'auto-?*'"
        );
        expect(normalizedSql).toContain(
            "substr(candidate_model_ids.candidate, 5), candidate_model_ids.depth + 1 FROM candidate_model_ids WHERE candidate_model_ids.depth < 6 AND candidate_model_ids.candidate GLOB 'any-?*'"
        );
        expect(normalizedSql).toContain('candidate_model_ids.depth < 6');
        expect(normalizedSql).toContain(
            "candidate_model_ids.candidate GLOB '*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'"
        );
    });

    it('overlays upstream metadata only onto non-custom rows of the refreshed provider', async () => {
        interceptTauriInvoke((call) => {
            if (call.cmd === 'database_query') {
                return { rows: [], rowsAffected: 1, lastInsertId: null };
            }

            return undefined;
        });

        await expect(
            applyUpstreamModelMetadata({
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
            'context_limit = COALESCE(( SELECT upstream_model_metadata.context_limit FROM upstream_model_metadata WHERE upstream_model_metadata.model_id = models.model_id ), context_limit)'
        );
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

    it('skips the upstream overlay when there is nothing to write', async () => {
        interceptTauriInvoke((call) => {
            if (call.cmd === 'database_query') {
                return { rows: [], rowsAffected: 1, lastInsertId: null };
            }

            return undefined;
        });

        await expect(
            applyUpstreamModelMetadata({ providerId: 7, entries: [] })
        ).resolves.toBeUndefined();

        expect(getTauriInvokeCalls('database_query')).toHaveLength(0);
    });

    it('clears stale reasoning options when upstream declares no reasoning', async () => {
        interceptTauriInvoke((call) => {
            if (call.cmd === 'database_query') {
                return { rows: [], rowsAffected: 1, lastInsertId: null };
            }

            return undefined;
        });

        await expect(
            applyUpstreamModelMetadata({
                providerId: 7,
                entries: [
                    {
                        model_id: 'any/claude-fable-5-1-reversed',
                        metadata: { reasoning: 0 },
                    },
                ],
            })
        ).resolves.toBeUndefined();

        const request = getTauriInvokeCalls('database_query')
            .map((call) => getRequest(call.payload))
            .find((candidate) => candidate?.method === 'run');
        const normalizedSql = request?.sql.replace(/\s+/g, ' ').trim() ?? '';

        // 显式 false 必须清掉 models.dev 兜底留下的旧档位，避免 flag 与档位打架。
        expect(normalizedSql).toContain(
            'reasoning_options = CASE WHEN ( SELECT upstream_model_metadata.reasoning FROM upstream_model_metadata WHERE upstream_model_metadata.model_id = models.model_id ) = 0 THEN NULL'
        );
        expect(normalizedSql).toContain(
            'ELSE COALESCE(( SELECT upstream_model_metadata.reasoning_options FROM upstream_model_metadata WHERE upstream_model_metadata.model_id = models.model_id ), reasoning_options) END'
        );
    });

    it('uses only sqlite-safe model metadata matching SQL', async () => {
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

        expect(normalizedSql).not.toContain('lower(models.model_id)');
        expect(normalizedSql).not.toContain('length(models.model_id)');
        expect(normalizedSql).toContain(
            'substr(candidate_model_ids.candidate, 1, length(candidate_model_ids.candidate)'
        );
    });
});
