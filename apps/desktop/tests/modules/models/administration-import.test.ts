import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import { createModelAdministration } from '@/modules/models';

afterEach(closeTestDatabases);

function entry(modelId: string) {
    return {
        provider: {
            name: `Imported ${modelId}`,
            driver: 'openai' as const,
            api_endpoint: 'https://gateway.example.test/v1',
            api_key: 'test-only-key',
            logo: 'openai.png',
            enabled: 1 as const,
            is_builtin: 0 as const,
        },
        model: { name: modelId, model_id: modelId },
    };
}

describe('given local provider settings selected for import', () => {
    it('user gets every provider and model while existing settings and default stay intact', async () => {
        const database = openMigratedDatabase();
        database.exec(`
            INSERT INTO providers (id, name, driver, api_endpoint, logo)
            VALUES (1, 'Existing', 'openai', 'https://existing.example.test', 'openai');
            INSERT INTO models (id, provider_id, name, model_id, is_default)
            VALUES (1, 1, 'Existing model', 'existing-model', 1);
        `);
        routeQueriesTo(database);
        const administration = createModelAdministration();

        try {
            const imported = await administration.importProviders({
                entries: [entry('gpt-first'), entry('gpt-second')],
            });

            expect(imported).toHaveLength(2);
            expect(
                database
                    .prepare(
                        'SELECT name, driver, api_endpoint, api_key, enabled, is_builtin FROM providers ORDER BY id'
                    )
                    .all()
            ).toMatchObject([
                {
                    name: 'Existing',
                    enabled: 1,
                    is_builtin: 0,
                },
                {
                    name: 'Imported gpt-first',
                    driver: 'openai',
                    api_endpoint: 'https://gateway.example.test/v1',
                    api_key: 'test-only-key',
                    enabled: 1,
                    is_builtin: 0,
                },
                {
                    name: 'Imported gpt-second',
                    driver: 'openai',
                    api_endpoint: 'https://gateway.example.test/v1',
                    api_key: 'test-only-key',
                    enabled: 1,
                    is_builtin: 0,
                },
            ]);
            expect(
                database
                    .prepare('SELECT provider_id, model_id, is_default FROM models ORDER BY id')
                    .all()
            ).toMatchObject([
                { provider_id: 1, model_id: 'existing-model', is_default: 1 },
                { provider_id: imported[0]!.provider.id, model_id: 'gpt-first', is_default: 0 },
                { provider_id: imported[1]!.provider.id, model_id: 'gpt-second', is_default: 0 },
            ]);
        } finally {
            await administration.dispose();
        }
    });

    it('user sees no partial import when a later model fails and can retry safely', async () => {
        const database = openMigratedDatabase();
        database.exec(
            "CREATE TRIGGER fail_import BEFORE INSERT ON models WHEN NEW.model_id = 'unavailable-model' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
        );
        routeQueriesTo(database);
        const administration = createModelAdministration();

        try {
            await expect(
                administration.importProviders({
                    entries: [entry('gpt-first'), entry('unavailable-model')],
                })
            ).rejects.toThrow();
            expect(database.prepare('SELECT count(*) AS count FROM providers').get()?.count).toBe(
                0
            );
            expect(database.prepare('SELECT count(*) AS count FROM models').get()?.count).toBe(0);

            database.exec('DROP TRIGGER fail_import');
            await expect(
                administration.importProviders({ entries: [entry('gpt-first')] })
            ).resolves.toHaveLength(1);
            expect(database.prepare('SELECT count(*) AS count FROM providers').get()?.count).toBe(
                1
            );
            expect(database.prepare('SELECT count(*) AS count FROM models').get()?.count).toBe(1);
        } finally {
            await administration.dispose();
        }
    });
});
