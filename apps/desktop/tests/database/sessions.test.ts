import {
    dismissSessionTerminalStatus,
    findSessionById,
    refreshSessionMetadata,
} from '@database/queries/sessions';
import { afterEach, describe, expect, it } from 'vitest';

import { openMigratedDatabase, routeQueriesTo } from './sqliteHarness';

const databases: ReturnType<typeof openMigratedDatabase>[] = [];

function openDatabase() {
    const database = openMigratedDatabase();
    databases.push(database);
    routeQueriesTo(database);
    return database;
}

function seedProvidersAndModels(database: ReturnType<typeof openMigratedDatabase>) {
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES
            (11, 'Chosen provider', 'openai', 'https://chosen.example/v1', 'chosen.png'),
            (22, 'Turn provider', 'openai', 'https://turn.example/v1', 'turn.png');
        INSERT INTO models (id, provider_id, name, model_id)
        VALUES
            (101, 11, 'Chosen model', 'chosen-model'),
            (202, 22, 'Turn model', 'turn-model');
        INSERT INTO sessions (id, session_id, title, model, provider_id)
        VALUES (7, 'session-7', 'Conversation', 'chosen-model', 11);
    `);
}

afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
});

describe('when a conversation records its model', () => {
    it('user keeps the provider they picked before the first message is sent', async () => {
        const database = openDatabase();
        seedProvidersAndModels(database);

        await refreshSessionMetadata(7);

        expect(database.prepare('SELECT provider_id FROM sessions WHERE id = 7').get()).toEqual({
            provider_id: 11,
        });
    });

    it('user sees the provider of the latest turn after a message records its model', async () => {
        const database = openDatabase();
        seedProvidersAndModels(database);
        database.exec(`
            INSERT INTO session_turns (session_id, model_id, task_id, prompt_snapshot_json)
            VALUES (7, 202, 'task-7', '{}');
        `);

        await refreshSessionMetadata(7);

        expect(database.prepare('SELECT provider_id FROM sessions WHERE id = 7').get()).toEqual({
            provider_id: 22,
        });
    });
});

describe('when a conversation finishes a turn', () => {
    it('user clears the terminal badge after dismissing it', async () => {
        const database = openDatabase();
        seedProvidersAndModels(database);
        database.exec(`
            INSERT INTO session_turns (session_id, model_id, task_id, prompt_snapshot_json, status)
            VALUES (7, 202, 'task-7', '{}', 'completed');
        `);

        await expect(findSessionById(7)).resolves.toMatchObject({
            pending_terminal_status: 'completed',
        });

        await dismissSessionTerminalStatus(7);

        await expect(findSessionById(7)).resolves.toMatchObject({
            pending_terminal_status: null,
        });
    });
});
