import {
    createModelPreference,
    deleteModelPreference,
    findEffectiveModelRoleWithProvider,
    findModelPreferenceByName,
    findModelRoleWithProvider,
    isModelRoutingEnabled,
    listModelPreferences,
    setModelRole,
    updateModelPreference,
} from '@database/queries/modelPreferences';
import { setSetting } from '@database/queries/settings';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';

import { closeTestDatabases, openMigratedDatabase, routeQueriesTo } from './sqliteHarness';

let database: ReturnType<typeof openMigratedDatabase>;

function seedModels() {
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo, enabled)
            VALUES (1, 'Provider A', 'openai', 'https://a.example', '', 1),
                   (2, 'Provider B', 'openai', 'https://b.example', '', 0);

        INSERT INTO models (id, provider_id, name, model_id)
            VALUES (1, 1, 'Fast model', 'fast-model'),
                   (2, 1, 'General model', 'general-model'),
                   (3, 2, 'Disabled model', 'disabled-model');
    `);
}

async function createScenario(name = 'Frontend', modelId = 1) {
    return await createModelPreference({
        name,
        description: 'React, Vue, CSS and component work',
        model_id: modelId,
    });
}

beforeEach(() => {
    setLocale('en-US');
    database = openMigratedDatabase();
    routeQueriesTo(database);
    seedModels();
});

afterEach(() => {
    closeTestDatabases();
});

describe('user configures a scenario model', () => {
    it('user sees a created scenario with its provider and model names', async () => {
        const created = await createScenario();

        const preferences = await listModelPreferences();

        expect(preferences).toEqual([
            expect.objectContaining({
                id: created.id,
                name: 'Frontend',
                description: 'React, Vue, CSS and component work',
                model_id: 1,
                model_name: 'Fast model',
                model_api_id: 'fast-model',
                provider_name: 'Provider A',
                provider_enabled: 1,
            }),
        ]);
    });

    it('user gets the scenario found by its exact name', async () => {
        await createScenario('Backend');

        await expect(findModelPreferenceByName('Backend')).resolves.toMatchObject({
            name: 'Backend',
            model_name: 'Fast model',
        });
        await expect(findModelPreferenceByName('backend')).resolves.toBeUndefined();
    });

    it('user gets a duplicate scenario name rejected regardless of casing', async () => {
        await createScenario('Frontend');

        await expect(createScenario('frontend', 2)).rejects.toThrow(
            'A scenario named "frontend" already exists'
        );
        await expect(listModelPreferences()).resolves.toHaveLength(1);
    });

    it('user gets a blank scenario rejected before anything is stored', async () => {
        await expect(
            createModelPreference({ name: '   ', description: 'Description', model_id: 1 })
        ).rejects.toThrow('Enter a scenario name');
        await expect(
            createModelPreference({ name: 'Frontend', description: '  ', model_id: 1 })
        ).rejects.toThrow('Enter a scenario description');
        await expect(
            createModelPreference({ name: 'Frontend', description: 'Description' })
        ).rejects.toThrow('Select a model');
        await expect(listModelPreferences()).resolves.toEqual([]);
    });

    it('user gets a missing or disabled model rejected', async () => {
        await expect(createScenario('Missing', 99)).rejects.toThrow(
            'The selected model does not exist'
        );
        await expect(createScenario('Disabled', 3)).rejects.toThrow(
            "The selected model's provider is disabled"
        );
        await expect(listModelPreferences()).resolves.toEqual([]);
    });

    it('user gets edited scenario text and model saved while the id stays stable', async () => {
        const created = await createScenario();

        await updateModelPreference(created.id, {
            name: 'Web client',
            description: 'Browser-side implementation work',
            model_id: 2,
        });

        await expect(findModelPreferenceByName('Web client')).resolves.toMatchObject({
            id: created.id,
            description: 'Browser-side implementation work',
            model_id: 2,
            model_name: 'General model',
        });
    });

    it('user gets an edit rejected when it would duplicate another scenario name', async () => {
        const first = await createScenario('Frontend');
        await createScenario('Backend', 2);

        await expect(updateModelPreference(first.id, { name: 'Backend' })).rejects.toThrow(
            'A scenario named "Backend" already exists'
        );
        await expect(findModelPreferenceByName('Frontend')).resolves.toMatchObject({
            id: first.id,
        });
    });

    it('user gets an edited scenario saved when its model is unchanged', async () => {
        const created = await createScenario();

        await updateModelPreference(created.id, { description: 'Updated description' });

        await expect(findModelPreferenceByName('Frontend')).resolves.toMatchObject({
            model_id: 1,
            description: 'Updated description',
        });
    });

    it('user gets a scenario removed when they delete it', async () => {
        const created = await createScenario();

        await expect(deleteModelPreference(created.id)).resolves.toBe(true);
        await expect(listModelPreferences()).resolves.toEqual([]);
        await expect(deleteModelPreference(created.id)).resolves.toBe(false);
    });

    it('user gets unsupported stored entries ignored instead of breaking the list', async () => {
        await setSetting({ key: 'model_preferences', value: 'not-json' });

        await expect(listModelPreferences()).resolves.toEqual([]);
    });
});

describe('user assigns base models', () => {
    it('user sees the default model serve as the entry role', async () => {
        await setModelRole({ role: 'entry', modelId: 1 });

        await expect(findModelRoleWithProvider('entry')).resolves.toMatchObject({
            id: 1,
            provider_name: 'Provider A',
        });
    });

    it('user gets an explicit fast or general model preferred over the default', async () => {
        await setModelRole({ role: 'entry', modelId: 1 });
        await setModelRole({ role: 'fast', modelId: 2 });

        await expect(findModelRoleWithProvider('fast')).resolves.toMatchObject({ id: 2 });
        await expect(findEffectiveModelRoleWithProvider('general')).resolves.toMatchObject({
            id: 1,
        });
    });

    it('user sees an unset fast or general role fall back to the default model', async () => {
        await setModelRole({ role: 'entry', modelId: 1 });

        await expect(findModelRoleWithProvider('fast')).resolves.toBeNull();
        await expect(findEffectiveModelRoleWithProvider('fast')).resolves.toMatchObject({ id: 1 });
    });

    it('user gets the optional role cleared back to the default model', async () => {
        await setModelRole({ role: 'entry', modelId: 1 });
        await setModelRole({ role: 'general', modelId: 2 });
        await setModelRole({ role: 'general', modelId: null });

        await expect(findModelRoleWithProvider('general')).resolves.toBeNull();
        await expect(findEffectiveModelRoleWithProvider('general')).resolves.toMatchObject({
            id: 1,
        });
    });

    it('user gets a disabled model rejected for any role', async () => {
        await expect(setModelRole({ role: 'entry', modelId: 3 })).rejects.toThrow(
            "The selected model's provider is disabled"
        );
        await expect(setModelRole({ role: 'fast', modelId: 3 })).rejects.toThrow(
            "The selected model's provider is disabled"
        );
    });

    it('user gets the default model required for the entry role', async () => {
        await expect(setModelRole({ role: 'entry', modelId: null })).rejects.toThrow(
            'Select a default model'
        );
    });

    it('user sees routing stay off until they turn it on', async () => {
        await expect(isModelRoutingEnabled()).resolves.toBe(false);

        await setSetting({ key: 'allow_model_auto_switch', value: 'true' });

        await expect(isModelRoutingEnabled()).resolves.toBe(true);
    });
});
