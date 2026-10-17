import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import { applyUpstreamModelMetadata } from '@database/queries/models';
import { interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

import { syncAllModelsMetadata } from '@/services/AgentService/infrastructure/modelMetadata/sync';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');
const databaseRoot = resolve('src/database');
const journal = JSON.parse(readFileSync(`${databaseRoot}/drizzle/meta/_journal.json`, 'utf8')) as {
    entries: Array<{ tag: string }>;
};
const databases: SqliteDatabase[] = [];

function openDatabase(): SqliteDatabase {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    for (const entry of journal.entries) {
        database.exec(readFileSync(`${databaseRoot}/drizzle/${entry.tag}.sql`, 'utf8'));
    }
    return database;
}

function routeQueriesTo(database: SqliteDatabase) {
    interceptTauriInvoke((call) => {
        if (call.cmd === 'database_tx_begin') {
            database.exec('BEGIN');
            return 'test-tx';
        }
        if (call.cmd === 'database_tx_commit') {
            database.exec('COMMIT');
            return null;
        }
        if (call.cmd === 'database_tx_rollback') {
            database.exec('ROLLBACK');
            return null;
        }
        if (call.cmd !== 'database_query' && call.cmd !== 'database_tx_query') return undefined;
        const { request } = call.payload as {
            request: { sql: string; params: SQLInputValue[]; method: string };
        };
        const statement = database.prepare(request.sql);
        if (request.method === 'run') {
            const result = statement.run(...request.params);
            return {
                rows: [],
                rowsAffected: Number(result.changes),
                lastInsertId: Number(result.lastInsertRowid),
            };
        }
        return { rows: statement.all(...request.params), rowsAffected: 0, lastInsertId: null };
    });
}
afterEach(() => databases.splice(0).forEach((database) => database.close()));

/** 网关模型 + 一条 models.dev 兜底：别名命中 `gpt-5-6-sol`。 */
function seedGateway(database: SqliteDatabase) {
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (7, 'Magpie', 'openai', 'http://127.0.0.1:3425/v1', 'openai.png');

        INSERT INTO models (id, provider_id, name, model_id) VALUES
            (1, 7, 'auto-gpt-5-6-sol', 'group/auto-gpt-5-6-sol'),
            (2, 7, 'private-model', 'magpie/private-model');

        INSERT INTO llm_metadata_aliases (alias, model_id)
        VALUES ('gpt-5-6-sol', 'openai/gpt-5-6-sol');

        INSERT INTO llm_metadata (
            model_id, name, attachment, modalities, reasoning, reasoning_options,
            temperature, tool_call, "limit"
        ) VALUES (
            'openai/gpt-5-6-sol', 'GPT 5.6 Sol', 0,
            '{"input":["text"],"output":["text"]}', 1,
            '[{"type":"effort","values":["low","high"]}]', 1, 1,
            '{"context":128000,"output":32000}'
        );
    `);
}

function modelRow(database: SqliteDatabase, id: number) {
    return database
        .prepare(
            `SELECT context_limit, output_limit, modalities, attachment, reasoning,
                    reasoning_options, tool_call, upstream_metadata
             FROM models WHERE id = ?`
        )
        .get(id) as Record<string, unknown>;
}

describe('upstream model metadata persistence', () => {
    it('keeps upstream declarations when the models.dev sync runs again', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedGateway(database);

        await syncAllModelsMetadata();
        expect(modelRow(database, 1)).toMatchObject({
            context_limit: 128000,
            reasoning: 1,
            reasoning_options: '[{"type":"effort","values":["low","high"]}]',
            upstream_metadata: null,
        });

        await applyUpstreamModelMetadata({
            providerId: 7,
            entries: [
                {
                    model_id: 'group/auto-gpt-5-6-sol',
                    metadata: {
                        context_limit: 400000,
                        modalities: '{"input":["text","image"],"output":["text"]}',
                        attachment: 1,
                        reasoning: 0,
                    },
                },
            ],
        });

        const overlaid = modelRow(database, 1);
        expect(overlaid).toMatchObject({
            context_limit: 400000,
            modalities: '{"input":["text","image"],"output":["text"]}',
            attachment: 1,
            reasoning: 0,
            reasoning_options: null,
        });
        expect(JSON.parse(String(overlaid.upstream_metadata))).toEqual({
            context_limit: 400000,
            modalities: '{"input":["text","image"],"output":["text"]}',
            attachment: 1,
            reasoning: 0,
        });

        // 重启 / 定时刷新会重跑 models.dev 兜底，上游能力必须保留。
        await syncAllModelsMetadata();
        expect(modelRow(database, 1)).toMatchObject({
            context_limit: 400000,
            modalities: '{"input":["text","image"],"output":["text"]}',
            attachment: 1,
            reasoning: 0,
            reasoning_options: null,
        });
    });

    it('reapplies declared capabilities on rows without a models.dev match', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedGateway(database);

        const reasoningOptions = '[{"type":"effort","values":["low","high","ultra"]}]';
        await applyUpstreamModelMetadata({
            providerId: 7,
            entries: [
                {
                    model_id: 'magpie/private-model',
                    metadata: {
                        context_limit: 200000,
                        reasoning: 1,
                        reasoning_options: reasoningOptions,
                        tool_call: 1,
                    },
                },
            ],
        });

        await syncAllModelsMetadata();
        expect(modelRow(database, 2)).toMatchObject({
            context_limit: 200000,
            reasoning: 1,
            reasoning_options: reasoningOptions,
        });
    });

    it('keeps earlier declarations when a later refresh only declares new fields', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedGateway(database);

        await applyUpstreamModelMetadata({
            providerId: 7,
            entries: [
                {
                    model_id: 'group/auto-gpt-5-6-sol',
                    metadata: { context_limit: 400000, tool_call: 1 },
                },
            ],
        });
        await applyUpstreamModelMetadata({
            providerId: 7,
            entries: [
                {
                    model_id: 'group/auto-gpt-5-6-sol',
                    metadata: { output_limit: 200000 },
                },
            ],
        });

        await syncAllModelsMetadata();
        expect(modelRow(database, 1)).toMatchObject({
            context_limit: 400000,
            output_limit: 200000,
            tool_call: 1,
        });
    });
});
