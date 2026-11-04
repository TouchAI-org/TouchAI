import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import {
    type LlmMetadataRecord,
    type ModelMetadataTarget,
    resolveModelMetadataRow,
    selectModelMetadata,
    syncAllModelsMetadata,
} from '@/services/AgentService/infrastructure/modelMetadata/sync';

afterEach(closeTestDatabases);

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

describe('user sees model metadata matched to the catalog', () => {
    it('user sees the candidate with the fewest stripping steps win', () => {
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

    it('user sees the richer metadata win when stripping depth is equal', () => {
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

    it('user sees the longer canonical id win and ties resolved deterministically', () => {
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

    it('user sees aliases without a metadata row skipped', () => {
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

describe('user sees the metadata row resolved for a model', () => {
    const fallback = metadata('openai/gpt-5-6-sol', {
        attachment: 0,
        reasoning: 1,
        reasoningOptions: '[{"type":"effort","values":["low","high"]}]',
        contextLimit: 128000,
        outputLimit: 32000,
    });

    it('user sees recorded upstream declarations preferred over the catalog fallback', () => {
        const row = resolveModelMetadataRow(
            {
                id: 1,
                modelId: 'group/auto-gpt-5-6-sol',
                upstreamMetadata: JSON.stringify({ context_limit: 400000, reasoning: 0 }),
            },
            fallback
        );

        // 上游显式不支持思考时，兜底档位一并清空；未声明的字段继续用兜底值。
        expect(row).toMatchObject({
            context_limit: 400000,
            reasoning: 0,
            reasoning_options: null,
            clear_reasoning_options: 1,
            output_limit: 32000,
        });
    });

    it('user sees the catalog fallback used and existing values kept when nothing is declared', () => {
        const row = resolveModelMetadataRow(
            { id: 1, modelId: 'group/auto-gpt-5-6-sol', upstreamMetadata: null },
            fallback
        );

        expect(row).toMatchObject({
            context_limit: 128000,
            reasoning: 1,
            reasoning_options: '[{"type":"effort","values":["low","high"]}]',
            clear_reasoning_options: 0,
        });

        expect(
            resolveModelMetadataRow(
                { id: 1, modelId: 'group/auto-gpt-5-6-sol', upstreamMetadata: '{not json' },
                undefined
            )
        ).toBeNull();
    });
});

describe('user sees every model synced in one pass', () => {
    it('user sees matching catalog metadata written to the runtime model', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO providers (id, name, driver, api_endpoint, logo)
            VALUES (1, 'OpenAI', 'openai', 'https://openai.example/v1', 'openai.png');
            INSERT INTO models (id, provider_id, name, model_id)
            VALUES (1, 1, 'GPT 5.6 Sol', 'group/auto-gpt-5-6-sol');
            INSERT INTO llm_metadata_aliases (alias, model_id)
            VALUES ('gpt-5-6-sol', 'openai/gpt-5-6-sol');
            INSERT INTO llm_metadata (
                model_id, name, attachment, modalities, open_weights, reasoning,
                release_date, temperature, tool_call, knowledge, "limit"
            ) VALUES (
                'openai/gpt-5-6-sol', 'GPT 5.6 Sol', 1,
                '{"input":["text","image"],"output":["text"]}', 0, 1,
                '2025-09-01', 1, 1, NULL, '{"context":400000,"output":128000}'
            );
        `);

        await expect(syncAllModelsMetadata()).resolves.toBeUndefined();

        expect(
            database
                .prepare(
                    `SELECT attachment, modalities, reasoning, release_date, tool_call,
                            context_limit, output_limit
                     FROM models WHERE id = 1`
                )
                .get()
        ).toEqual({
            attachment: 1,
            modalities: '{"input":["text","image"],"output":["text"]}',
            reasoning: 1,
            release_date: '2025-09-01',
            tool_call: 1,
            context_limit: 400_000,
            output_limit: 128_000,
        });
    });

    it('user keeps existing model metadata when no catalog alias matches', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO providers (id, name, driver, api_endpoint, logo)
            VALUES (1, 'Local', 'openai', 'http://local', '');
            INSERT INTO models (
                id, provider_id, name, model_id, context_limit, output_limit, reasoning
            ) VALUES (1, 1, 'Local', 'private-model', 777, 333, 1);
        `);

        await expect(syncAllModelsMetadata()).resolves.toBeUndefined();

        expect(
            database
                .prepare('SELECT context_limit, output_limit, reasoning FROM models WHERE id = 1')
                .get()
        ).toEqual({ context_limit: 777, output_limit: 333, reasoning: 1 });
    });

    it('user keeps custom model metadata untouched', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO providers (id, name, driver, api_endpoint, logo)
            VALUES (1, 'OpenAI', 'openai', 'https://openai.example/v1', 'openai.png');
            INSERT INTO models (
                id, provider_id, name, model_id, context_limit, is_custom_metadata
            ) VALUES (1, 1, 'Custom', 'group/auto-gpt-5-6-sol', 555, 1);
            INSERT INTO llm_metadata_aliases (alias, model_id)
            VALUES ('gpt-5-6-sol', 'openai/gpt-5-6-sol');
            INSERT INTO llm_metadata (model_id, name, modalities, "limit")
            VALUES (
                'openai/gpt-5-6-sol', 'GPT 5.6 Sol',
                '{"input":["text"],"output":["text"]}', '{"context":400000}'
            );
        `);

        await expect(syncAllModelsMetadata()).resolves.toBeUndefined();

        expect(database.prepare('SELECT context_limit FROM models WHERE id = 1').get()).toEqual({
            context_limit: 555,
        });
    });
});
