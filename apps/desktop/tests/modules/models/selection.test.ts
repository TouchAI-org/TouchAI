import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import { createModelSelection } from '@/modules/models';

afterEach(closeTestDatabases);

function fixture() {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    database.exec(`INSERT INTO providers (id, name, driver, api_endpoint, api_key, logo) VALUES
        (1, 'First', 'openai-compatible', 'https://first.invalid/v1', 'fixture-first', 'openai'),
        (2, 'Second', 'openai-compatible', 'https://second.invalid/v1', 'fixture-second', 'openai');
        INSERT INTO models (id, provider_id, name, model_id, is_default, tool_call, context_limit, output_limit, modalities) VALUES
        (1, 1, 'First model', 'same-model', 1, 1, 8192, 1024, '{"input":["text","image"],"output":["text"]}'),
        (2, 2, 'Second model', 'same-model', 0, 1, 8192, 1024, '{"input":["text"],"output":["text"]}');`);
    return { database, selection: createModelSelection() };
}

describe('given Desktop owns user model selection and connection configuration', () => {
    it('user receives a normal missing-configuration state without an implicit provider or network request', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        await expect(createModelSelection().get()).rejects.toMatchObject({
            code: 'NO_ACTIVE_MODEL',
        });
    });

    it('user keeps same-named models isolated by their selected connection and sees only safe model summaries', async () => {
        const { selection } = fixture();
        const first = await selection.get();
        const second = await selection.get({ providerId: 2, modelId: 'same-model' });
        expect(first.connection).toMatchObject({
            providerId: 1,
            apiEndpoint: 'https://first.invalid/v1',
            apiKey: 'fixture-first',
        });
        expect(second.connection).toMatchObject({
            providerId: 2,
            apiEndpoint: 'https://second.invalid/v1',
            apiKey: 'fixture-second',
        });
        expect(first.capabilities).toMatchObject({
            supportsImages: true,
            supportsTools: true,
            contextLimit: 8192,
        });
        expect(second.capabilities.supportsImages).toBe(false);
        expect(first.summary).toEqual({
            modelDbId: 1,
            providerId: 1,
            providerName: 'First',
            modelId: 'same-model',
            modelName: 'First model',
        });
        expect(Object.keys(first.summary)).not.toEqual(
            expect.arrayContaining(['apiKey', 'connection', 'provider_config_json', 'api_key'])
        );
        expect(Object.keys(first)).not.toEqual(
            expect.arrayContaining(['api_key', 'provider_config_json', 'context_limit'])
        );
    });

    it('user cannot authorize an old profile snapshot after an endpoint edit and retains atomic default selection', async () => {
        const { database, selection } = fixture();
        const first = await selection.get();
        expect(await selection.isCurrent(first)).toBe(true);
        database.exec(
            `UPDATE providers SET api_endpoint = 'https://replacement.invalid/v1' WHERE id = 1;`
        );
        expect(await selection.isCurrent(first)).toBe(false);
        await selection.setDefault(2);
        expect((await selection.get()).summary.providerId).toBe(2);
        expect(database.prepare('SELECT id, is_default FROM models ORDER BY id').all()).toEqual([
            { id: 1, is_default: 0 },
            { id: 2, is_default: 1 },
        ]);
        database.exec(`UPDATE providers SET enabled = 0 WHERE id = 1;`);
        await expect(selection.setDefault(1)).rejects.toThrow();
        expect((await selection.get()).summary.providerId).toBe(2);
    });
});
