import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import { findModelOption, getActiveModel, listModelOptions } from '@/app/api/models/selection';

afterEach(closeTestDatabases);

function fixture() {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    database.exec(`INSERT INTO providers (id, name, driver, api_endpoint, api_key, config_json, logo) VALUES
        (1, 'First', 'openai-compatible', 'https://first.invalid/v1', 'first-fixture-secret', '{"headers":{"Authorization":"fixture"}}', 'openai'),
        (2, 'Second', 'openai-compatible', 'https://second.invalid/v1', 'second-fixture-secret', '{}', 'openai');
        INSERT INTO models (id, provider_id, name, model_id, is_default, tool_call, attachment, modalities) VALUES
        (1, 1, 'Default model', 'same-model', 1, 1, 1, '{"input":["text","image"],"output":["text"]}'),
        (2, 2, 'Alternative model', 'same-model', 0, 0, 0, NULL);`);
    return database;
}

describe('given ordinary window model queries use the app display contract', () => {
    it('user sees default and alternative metadata without any connection secrets or executable provider', async () => {
        fixture();
        const active = await getActiveModel();
        const options = await listModelOptions();
        expect(active).toMatchObject({
            id: 1,
            model_id: 'same-model',
            provider_id: 1,
            name: 'Default model',
            tool_call: 1,
            attachment: 1,
        });
        expect(options.map(({ id, provider_name }) => ({ id, provider_name }))).toEqual([
            { id: 1, provider_name: 'First' },
            { id: 2, provider_name: 'Second' },
        ]);
        expect(JSON.stringify({ active, options })).not.toMatch(
            /fixture-secret|api_key|api_endpoint|provider_config_json|Authorization/
        );
        expect(options.every((option) => !('request' in option) && !('stream' in option))).toBe(
            true
        );
    });

    it('user resolves a saved override by both connection and model identity rather than another provider with the same model name', async () => {
        fixture();
        expect(await findModelOption({ providerId: 2, modelId: 'same-model' })).toMatchObject({
            id: 2,
            provider_id: 2,
            name: 'Alternative model',
        });
        expect(await findModelOption({ providerId: 2, modelId: 'missing-model' })).toBeNull();
        expect((await listModelOptions({ providerId: 2 })).map(({ id }) => id)).toEqual([2]);
    });

    it('user sees no active default when its provider is disabled while saved alternatives remain discoverable', async () => {
        const database = fixture();
        database.exec('UPDATE providers SET enabled = 0 WHERE id = 1');
        expect(await getActiveModel()).toBeNull();
        expect(
            (await listModelOptions()).map(({ id, provider_enabled }) => ({ id, provider_enabled }))
        ).toEqual([
            { id: 1, provider_enabled: 0 },
            { id: 2, provider_enabled: 1 },
        ]);
    });
});
