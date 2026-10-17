import type { InvokeArgs } from '@tauri-apps/api/core';
import { getTauriInvokeCalls, interceptTauriInvoke } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

import {
    type LlmMetadataRecord,
    type ModelMetadataTarget,
    selectModelMetadata,
    syncAllModelsMetadata,
} from '@/services/AgentService/infrastructure/modelMetadata/sync';

function getRequest(payload: InvokeArgs | undefined) {
    return (payload as { request?: { sql: string; params?: unknown[]; method: string } })?.request;
}

function metadata(modelId: string, overrides: Partial<LlmMetadataRecord> = {}): LlmMetadataRecord {
    return {
        modelId,
        attachment: 0,
        modalities: '{"input":["text"],"output":["text"]}',
        openWeights: 0,
        reasoning: 0,
        reasoningOptions: null,
        releaseDate: null,
        temperature: 0,
        toolCall: 0,
        knowledge: null,
        contextLimit: null,
        outputLimit: null,
        ...overrides,
    };
}

function selectWith(
    target: ModelMetadataTarget,
    aliasTargets: Record<string, string>,
    records: LlmMetadataRecord[]
) {
    return selectModelMetadata(
        [target],
        new Map(Object.entries(aliasTargets)),
        new Map(records.map((record) => [record.modelId, record]))
    );
}

describe('model metadata matching', () => {
    it('prefers the candidate with the fewest stripping steps', () => {
        const selections = selectWith(
            { id: 1, modelId: 'any/claude-3-5-haiku' },
            {
                'any/claude-3-5-haiku': 'gateway/claude-3-5-haiku',
                'claude-3-5-haiku': 'anthropic/claude-3-5-haiku',
            },
            [metadata('gateway/claude-3-5-haiku'), metadata('anthropic/claude-3-5-haiku')]
        );

        expect(selections).toHaveLength(1);
        expect(selections[0]!.metadata.modelId).toBe('gateway/claude-3-5-haiku');
    });

    it('prefers richer metadata when stripping depth is equal', () => {
        const aliasTargets = {
            'workbuddy-ai/step-5': 'vendor/step-5',
            'step-5-preview': 'vendor/step-5-preview',
        };
        const lean = metadata('vendor/step-5');
        const rich = metadata('vendor/step-5-preview', {
            attachment: 1,
            reasoning: 1,
            toolCall: 1,
        });

        const preferRich = selectWith(
            { id: 1, modelId: 'workbuddy-ai/step-5-preview' },
            aliasTargets,
            [lean, rich]
        );
        expect(preferRich[0]!.metadata.modelId).toBe('vendor/step-5-preview');

        const preferOther = selectWith(
            { id: 1, modelId: 'workbuddy-ai/step-5-preview' },
            aliasTargets,
            [metadata('vendor/step-5', { attachment: 1 }), lean]
        );
        expect(preferOther[0]!.metadata.modelId).toBe('vendor/step-5');
    });

    it('prefers longer canonical ids and stays deterministic on full ties', () => {
        const longer = selectWith(
            { id: 1, modelId: 'workbuddy-ai/step-5-preview' },
            {
                'workbuddy-ai/step-5': 'aaa',
                'step-5-preview': 'vendor/step-5-preview',
            },
            [metadata('aaa'), metadata('vendor/step-5-preview')]
        );
        expect(longer[0]!.metadata.modelId).toBe('vendor/step-5-preview');

        const tieBreak = selectWith(
            { id: 1, modelId: 'workbuddy-ai/step-5-preview' },
            {
                'workbuddy-ai/step-5': 'bbb',
                'step-5-preview': 'aaa',
            },
            [metadata('bbb'), metadata('aaa')]
        );
        expect(tieBreak[0]!.metadata.modelId).toBe('aaa');
    });

    it('skips aliases whose metadata row is missing and rows without matches', () => {
        const selections = selectModelMetadata(
            [
                { id: 1, modelId: 'any/claude-3-5-haiku' },
                { id: 2, modelId: 'unknown-model' },
            ],
            new Map([
                ['claude-3-5-haiku', 'anthropic/claude-3-5-haiku'],
                ['any/claude-3-5-haiku', 'deleted/model'],
            ]),
            new Map([['anthropic/claude-3-5-haiku', metadata('anthropic/claude-3-5-haiku')]])
        );

        expect(selections).toHaveLength(1);
        expect(selections[0]!.modelRowId).toBe(1);
        expect(selections[0]!.metadata.modelId).toBe('anthropic/claude-3-5-haiku');
    });
});

describe('syncAllModelsMetadata', () => {
    const MODEL_ROW = { id: 1, model_id: 'group/auto-gpt-5-6-sol' };
    const METADATA_ROW = {
        model_id: 'openai/gpt-5-6-sol',
        attachment: 1,
        modalities: '{"input":["text","image"],"output":["text"]}',
        open_weights: 0,
        reasoning: 1,
        reasoning_options: null,
        release_date: '2025-09-01',
        temperature: 1,
        tool_call: 1,
        knowledge: null,
        limit: '{"context":400000,"output":128000}',
    };

    it('reads candidates, matches in memory and writes one bulk update', async () => {
        interceptTauriInvoke((call) => {
            if (call.cmd !== 'database_query') {
                return undefined;
            }

            const request = getRequest(call.payload);
            if (request?.method !== 'all') {
                return { rows: [], rowsAffected: 1, lastInsertId: null };
            }

            if (request.sql.includes('"llm_metadata_aliases"')) {
                return {
                    rows: [{ alias: 'gpt-5-6-sol', model_id: 'openai/gpt-5-6-sol' }],
                    rowsAffected: 0,
                    lastInsertId: null,
                };
            }

            if (request.sql.includes('"llm_metadata"')) {
                return { rows: [METADATA_ROW], rowsAffected: 0, lastInsertId: null };
            }

            return { rows: [MODEL_ROW], rowsAffected: 0, lastInsertId: null };
        });

        await expect(syncAllModelsMetadata()).resolves.toBeUndefined();

        const requests = getTauriInvokeCalls('database_query').map((call) =>
            getRequest(call.payload)
        );

        // 只同步非自定义行；匹配在应用层完成后只剩这一条 UPDATE。
        const modelSelect = requests.find(
            (request) =>
                request?.method === 'all' &&
                request.sql.includes('from "models"') &&
                request.sql.includes('"is_custom_metadata"')
        );
        expect(modelSelect?.sql).toContain('"models"."is_custom_metadata" = ?');
        expect(modelSelect?.params).toEqual([0]);

        const updateCalls = requests.filter((request) => request?.method === 'run');
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0]!.sql).toContain('UPDATE models');
        expect(updateCalls[0]!.sql).toContain('COALESCE');

        expect(JSON.parse(String(updateCalls[0]!.params?.[0]))).toEqual([
            {
                id: 1,
                attachment: 1,
                modalities: '{"input":["text","image"],"output":["text"]}',
                open_weights: 0,
                reasoning: 1,
                reasoning_options: null,
                release_date: '2025-09-01',
                temperature: 1,
                tool_call: 1,
                knowledge: null,
                context_limit: 400000,
                output_limit: 128000,
            },
        ]);
    });

    it('writes nothing when no candidate matches the alias table', async () => {
        interceptTauriInvoke((call) => {
            if (call.cmd !== 'database_query') {
                return undefined;
            }

            const request = getRequest(call.payload);
            if (request?.method === 'all' && request.sql.includes('"llm_metadata_aliases"')) {
                return { rows: [], rowsAffected: 0, lastInsertId: null };
            }

            if (request?.method === 'all') {
                return { rows: [MODEL_ROW], rowsAffected: 0, lastInsertId: null };
            }

            return { rows: [], rowsAffected: 1, lastInsertId: null };
        });

        await expect(syncAllModelsMetadata()).resolves.toBeUndefined();

        const runCalls = getTauriInvokeCalls('database_query').filter(
            (call) => getRequest(call.payload)?.method === 'run'
        );
        expect(runCalls).toHaveLength(0);
    });

    it('does not touch the database when there are no non-custom models', async () => {
        interceptTauriInvoke((call) => {
            if (call.cmd !== 'database_query') {
                return undefined;
            }

            return { rows: [], rowsAffected: 0, lastInsertId: null };
        });

        await expect(syncAllModelsMetadata()).resolves.toBeUndefined();

        expect(getTauriInvokeCalls('database_query')).toHaveLength(1);
    });
});
