import { afterEach, describe, expect, it } from 'vitest';

import { applyMigrationsAfter, createMigrationFixtureDatabase } from './utils/migrations';

const databases: ReturnType<typeof createMigrationFixtureDatabase>[] = [];
afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
});

describe('given the previous database schema contains historical calls', () => {
    it('user upgrades without losing retry content row identities or usage and later removes configuration safely', () => {
        const database = createMigrationFixtureDatabase('0005_performance_query_indexes');
        databases.push(database);
        database.exec(`
            INSERT INTO providers(id,name,driver,api_endpoint,logo) VALUES(1,'Existing provider','openai','https://fixture.invalid','');
            INSERT INTO models(id,provider_id,name,model_id) VALUES(1,1,'Existing model','fixture-model');
            INSERT INTO sessions(id,session_id,title,model) VALUES(1,'existing-session','History','fixture-model');
            INSERT INTO messages(id,session_id,role) VALUES(1,1,'user');
            INSERT INTO session_turns(id,session_id,model_id,task_id,prompt_snapshot_json,prompt_message_id,input_tokens,total_cost_micros)
                VALUES(55,1,1,'existing-task','{"userPrompt":"preserved content"}',1,120,250000);
            INSERT INTO session_turn_attempts(id,turn_id,attempt_index,checkpoint_json,delivery_manifest_json)
                VALUES(77,55,1,'{"iteration":2}','{}');
            UPDATE sqlite_sequence SET seq=1000 WHERE name='session_turns';
        `);
        applyMigrationsAfter(database, '0005_performance_query_indexes');
        expect(
            database
                .prepare(
                    'SELECT id,model_id,model_name,provider_name,prompt_snapshot_json,input_tokens,total_cost_micros FROM session_turns'
                )
                .get()
        ).toMatchObject({
            id: 55,
            model_id: 1,
            model_name: 'Existing model',
            provider_name: 'Existing provider',
            prompt_snapshot_json: '{"userPrompt":"preserved content"}',
            input_tokens: 120,
            total_cost_micros: 250000,
        });
        expect(
            database.prepare('SELECT id,turn_id,checkpoint_json FROM session_turn_attempts').get()
        ).toMatchObject({ id: 77, turn_id: 55, checkpoint_json: '{"iteration":2}' });
        expect(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
        database.exec('DELETE FROM providers WHERE id=1');
        expect(
            database
                .prepare('SELECT model_id,model_name,provider_name,input_tokens FROM session_turns')
                .get()
        ).toMatchObject({
            model_id: null,
            model_name: 'Existing model',
            provider_name: 'Existing provider',
            input_tokens: 120,
        });
        expect(database.prepare('SELECT count(*) AS n FROM session_turn_attempts').get()?.n).toBe(
            1
        );
        expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        const next = database
            .prepare(
                "INSERT INTO session_turns(model_id,task_id,prompt_snapshot_json) VALUES(NULL,'next-task','{}') RETURNING id"
            )
            .get();
        expect(Number(next?.id)).toBeGreaterThan(1000);
    });
});
