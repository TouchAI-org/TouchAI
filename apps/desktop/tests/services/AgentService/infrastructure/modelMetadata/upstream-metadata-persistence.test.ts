import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import { interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

import { persistRefreshedModels } from '@/services/AgentService/infrastructure/modelMetadata';
import { syncAllModelsMetadata } from '@/services/AgentService/infrastructure/modelMetadata/sync';
import type { ModelInfo } from '@/services/AgentService/infrastructure/providers';

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

/** 网关 + models.dev 兜底：别名命中 `gpt-5-6-sol`，只有第一个模型能匹配上。 */
function seedGateway(database: SqliteDatabase) {
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (7, 'Magpie', 'openai', 'http://127.0.0.1:3425/v1', 'openai.png'),
               (8, 'Other', 'openai', 'https://other.example.com/v1', 'openai.png');

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

function modelRow(database: SqliteDatabase, modelId: string) {
    return database
        .prepare(
            `SELECT id, context_limit, output_limit, modalities, attachment, reasoning,
                    reasoning_options, tool_call, upstream_metadata
             FROM models WHERE model_id = ? ORDER BY id`
        )
        .get(modelId) as Record<string, unknown>;
}

function countModels(database: SqliteDatabase, providerId: number) {
    return Number(
        database
            .prepare('SELECT count(*) AS total FROM models WHERE provider_id = ?')
            .get(providerId)?.total
    );
}

const magpieModels: ModelInfo[] = [
    {
        id: 'group/auto-gpt-5-6-sol',
        name: 'group/auto-gpt-5-6-sol',
        capabilities: {
            contextLimit: 400_000,
            modalities: { input: ['text', 'image'], output: ['text'] },
            attachment: true,
            reasoning: false,
        },
    },
    {
        id: 'magpie/private-model',
        name: 'magpie/private-model',
        capabilities: {
            contextLimit: 200_000,
            reasoning: true,
            reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'ultra'] }],
        },
    },
];

describe('user sees upstream model declarations persisted', () => {
    it('user sees missing rows created and declarations kept across syncs', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedGateway(database);

        await expect(
            persistRefreshedModels({ providerId: 7, models: magpieModels })
        ).resolves.toEqual({ addedCount: 2 });

        // 上游声明优先于 models.dev 兜底，显式 reasoning=false 连同档位一起清空。
        expect(modelRow(database, 'group/auto-gpt-5-6-sol')).toMatchObject({
            context_limit: 400_000,
            modalities: '{"input":["text","image"],"output":["text"]}',
            attachment: 1,
            reasoning: 0,
            reasoning_options: null,
            // 上游没声明的字段继续用 models.dev 兜底值。
            output_limit: 32_000,
        });
        expect(
            JSON.parse(String(modelRow(database, 'group/auto-gpt-5-6-sol').upstream_metadata))
        ).toEqual({
            context_limit: 400_000,
            modalities: '{"input":["text","image"],"output":["text"]}',
            attachment: 1,
            reasoning: 0,
        });

        // 没有 models.dev 命中的行同样按上游声明落列。
        expect(modelRow(database, 'magpie/private-model')).toMatchObject({
            context_limit: 200_000,
            reasoning: 1,
            reasoning_options: '[{"type":"effort","values":["low","high","ultra"]}]',
        });

        // 重启 / 定时刷新会重跑 models.dev 兜底，上游能力必须保留。
        await syncAllModelsMetadata();
        expect(modelRow(database, 'group/auto-gpt-5-6-sol')).toMatchObject({
            context_limit: 400_000,
            reasoning: 0,
            reasoning_options: null,
        });

        // 再次刷新不会重复建行，声明保持合并且结果稳定。
        await expect(
            persistRefreshedModels({ providerId: 7, models: magpieModels })
        ).resolves.toEqual({ addedCount: 0 });
        expect(countModels(database, 7)).toBe(2);
        expect(modelRow(database, 'magpie/private-model')).toMatchObject({
            context_limit: 200_000,
            reasoning_options: '[{"type":"effort","values":["low","high","ultra"]}]',
        });
    });

    it('user sees custom rows and other providers left untouched', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedGateway(database);
        database.exec(`
            INSERT INTO models (id, provider_id, name, model_id, context_limit, is_custom_metadata)
            VALUES (10, 7, 'custom', 'magpie/private-model', 5, 1),
                   (11, 8, 'foreign', 'group/auto-gpt-5-6-sol', null, 0);
        `);

        await persistRefreshedModels({ providerId: 7, models: magpieModels });

        // 用户自定义元数据的行不记声明、不改列，也不会被当成新模型补行。
        const customRow = database
            .prepare('SELECT context_limit, reasoning, upstream_metadata FROM models WHERE id = 10')
            .get() as Record<string, unknown>;
        expect(customRow).toEqual({
            context_limit: 5,
            reasoning: 0,
            upstream_metadata: null,
        });
        expect(countModels(database, 7)).toBe(2);

        // 其他服务商的同名模型行不会被记入这次上游声明，列仍由 models.dev 兜底重建。
        const foreignRow = database
            .prepare('SELECT context_limit, upstream_metadata FROM models WHERE id = 11')
            .get() as Record<string, unknown>;
        expect(foreignRow).toEqual({ context_limit: 128_000, upstream_metadata: null });
    });
});
