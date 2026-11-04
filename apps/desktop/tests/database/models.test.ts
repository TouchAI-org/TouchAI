import { recordUpstreamModelMetadata, setDefaultModel } from '@database/queries/models';
import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(closeTestDatabases);

function openRoutedDatabase() {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo, enabled)
        VALUES
            (7, 'OpenAI', 'openai', 'https://openai.example/v1', 'openai.png', 1),
            (8, 'Disabled', 'openai', 'https://disabled.example/v1', 'openai.png', 0);
    `);
    return database;
}

function defaultModelIds(database: ReturnType<typeof openMigratedDatabase>): number[] {
    return (
        database.prepare('SELECT id FROM models WHERE is_default = 1 ORDER BY id').all() as Array<{
            id: number;
        }>
    ).map((row) => Number(row.id));
}

describe('when the user changes which model is in use', () => {
    it('user gets exactly one default model after switching', async () => {
        const database = openRoutedDatabase();
        database.exec(`
            INSERT INTO models (id, provider_id, name, model_id, is_default)
            VALUES
                (1, 7, 'Old default', 'old-model', 1),
                (2, 7, 'New default', 'new-model', 0);
        `);

        await expect(setDefaultModel({ modelId: 2 })).resolves.toBeUndefined();

        expect(defaultModelIds(database)).toEqual([2]);
    });

    it('user keeps the previous default when the target provider is disabled', async () => {
        const database = openRoutedDatabase();
        database.exec(`
            INSERT INTO models (id, provider_id, name, model_id, is_default)
            VALUES
                (1, 7, 'Current', 'current-model', 1),
                (2, 8, 'Disabled', 'disabled-model', 0);
        `);

        await expect(setDefaultModel({ modelId: 2 })).rejects.toThrow(
            '无法设置默认模型：服务商 "Disabled" 未启用'
        );

        expect(defaultModelIds(database)).toEqual([1]);
    });

    it('user sees upstream declarations only on matching non-custom rows', async () => {
        const database = openRoutedDatabase();
        database.exec(`
            INSERT INTO models (
                id, provider_id, name, model_id, is_custom_metadata, upstream_metadata
            ) VALUES
                (1, 7, 'Synced', 'group/auto-gpt-5-6-sol', 0, NULL),
                (2, 7, 'Custom', 'group/auto-gpt-5-6-sol', 1, NULL),
                (3, 8, 'Other provider', 'group/auto-gpt-5-6-sol', 0, NULL);
        `);

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

        const rows = database
            .prepare('SELECT id, upstream_metadata FROM models ORDER BY id')
            .all() as Array<{ id: number; upstream_metadata: string | null }>;
        expect(JSON.parse(String(rows[0]!.upstream_metadata))).toEqual({
            context_limit: 400_000,
            reasoning: 1,
        });
        expect(rows[1]!.upstream_metadata).toBeNull();
        expect(rows[2]!.upstream_metadata).toBeNull();
    });

    it('user sees no upstream write when the provider declares nothing', async () => {
        const database = openRoutedDatabase();
        database.exec(`
            INSERT INTO models (id, provider_id, name, model_id, upstream_metadata)
            VALUES (1, 7, 'Synced', 'group/auto-gpt-5-6-sol', '{"context_limit":128000}');
        `);

        await expect(
            recordUpstreamModelMetadata({ providerId: 7, entries: [] })
        ).resolves.toBeUndefined();

        expect(database.prepare('SELECT upstream_metadata FROM models WHERE id = 1').get()).toEqual(
            { upstream_metadata: '{"context_limit":128000}' }
        );
    });
});
