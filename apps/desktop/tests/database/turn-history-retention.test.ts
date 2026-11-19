import type { DatabaseSync } from 'node:sqlite';

import { deleteModel, updateModel } from '@database/queries/models';
import { deleteProvider, updateProvider } from '@database/queries/providers';
import { createSession } from '@database/queries/sessions';
import {
    createSessionTurn,
    findLatestModelBySessionId,
    findSessionTurnsBySessionId,
    updateSessionTurnUsage,
} from '@database/queries/sessionTurns';
import { getContextProfiles, getContextTurnPoints } from '@database/queries/usageContext';
import {
    getModelRanking,
    getSessionRanking,
    getUsageByModel,
    getUsageByProvider,
    getUsageSummary,
    getUsageTrend,
} from '@database/queries/usageStats';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeTestDatabases, openMigratedDatabase, routeQueriesTo } from './sqliteHarness';

let database: DatabaseSync;
const filter = { from: '2020-01-01 00:00:00', to: '2020-01-02 00:00:00' };

beforeEach(() => {
    database = openMigratedDatabase();
    routeQueriesTo(database);
    database.exec(`
        INSERT INTO providers(id,name,driver,api_endpoint,logo) VALUES(1,'Original provider','openai','https://fixture.invalid','');
        INSERT INTO models(id,provider_id,name,model_id,context_limit) VALUES(1,1,'Original model','fixture-model',100000);
        INSERT INTO sessions(id,session_id,title,model) VALUES(1,'history-session','Saved session','fixture-model');
        INSERT INTO messages(id,session_id,role) VALUES(1,1,'user');
        INSERT INTO message_parts(message_id,type,content,sort_order) VALUES(1,'text','saved conversation',0);
    `);
});

afterEach(closeTestDatabases);

async function savedTurn() {
    const turn = await createSessionTurn({
        session_id: 1,
        model_id: 1,
        task_id: '00000000-0000-4000-8000-000000000001',
        prompt_snapshot_json: '{"userPrompt":"saved prompt"}',
        prompt_message_id: 1,
        status: 'completed',
        duration_ms: 1500,
        created_at: '2020-01-01 00:00:00',
    });
    await updateSessionTurnUsage({
        id: turn.id,
        usagePatch: {
            input_tokens: 120,
            output_tokens: 30,
            total_cost_micros: 250000,
            ttft_ms: 80,
            prompt_breakdown_json:
                '{"systemPromptTotal":100,"fragments":{"platform":100},"builtinToolDefinitions":0,"mcpToolDefinitions":0,"userPrompt":50,"attachments":0}',
        },
    });
    database
        .prepare(
            "INSERT INTO session_turn_attempts(turn_id,attempt_index,checkpoint_json,delivery_manifest_json,status) VALUES(?,1,'{}','{}','completed')"
        )
        .run(turn.id);
    return turn;
}

describe('given saved calls depend on editable model configuration', () => {
    it('user keeps historical calls and retry records when deleting a model', async () => {
        const turn = await savedTurn();
        await deleteModel({ id: 1 });
        expect(database.prepare('SELECT count(*) AS n FROM models').get()?.n).toBe(0);
        expect(
            database
                .prepare(
                    'SELECT model_id, task_id, prompt_snapshot_json, input_tokens, total_cost_micros FROM session_turns WHERE id=?'
                )
                .get(turn.id)
        ).toMatchObject({
            model_id: null,
            task_id: turn.task_id,
            prompt_snapshot_json: '{"userPrompt":"saved prompt"}',
            input_tokens: 120,
            total_cost_micros: 250000,
        });
        expect(
            database
                .prepare('SELECT count(*) AS n FROM session_turn_attempts WHERE turn_id=?')
                .get(turn.id)?.n
        ).toBe(1);
        expect(await findSessionTurnsBySessionId(1)).toHaveLength(1);
        expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });

    it('user does not see an older model as the latest after the newest model configuration is deleted', async () => {
        await savedTurn();
        const newerModel = Number(
            database
                .prepare(
                    "INSERT INTO models(id,provider_id,name,model_id)VALUES(2,1,'Newest model','newest') RETURNING id"
                )
                .get()?.id
        );
        const newer = await createSessionTurn({
            session_id: 1,
            model_id: newerModel,
            task_id: '00000000-0000-4000-8000-000000000002',
            prompt_snapshot_json: '{}',
            created_at: '2020-01-01 00:01:00',
        });
        expect(await findLatestModelBySessionId({ sessionId: 1 })).toMatchObject({
            id: newerModel,
        });
        await deleteModel({ id: newerModel });
        expect(await findLatestModelBySessionId({ sessionId: 1 })).toBeNull();
        expect(database.prepare('SELECT count(*) AS n FROM session_turns').get()?.n).toBe(2);
        expect(
            database
                .prepare('SELECT model_id,model_name FROM session_turns WHERE id=?')
                .get(newer.id)
        ).toMatchObject({ model_id: null, model_name: 'Newest model' });
    });

    it('user keeps calls from every removed model when deleting its provider', async () => {
        await savedTurn();
        await deleteProvider({ id: 1 });
        expect(database.prepare('SELECT count(*) AS n FROM providers').get()?.n).toBe(0);
        expect(database.prepare('SELECT count(*) AS n FROM models').get()?.n).toBe(0);
        expect(database.prepare('SELECT count(*) AS n FROM session_turns').get()?.n).toBe(1);
        expect(database.prepare('SELECT count(*) AS n FROM session_turn_attempts').get()?.n).toBe(
            1
        );
        expect(
            database.prepare("SELECT content FROM message_parts WHERE type='text'").get()?.content
        ).toBe('saved conversation');
        expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });

    it('user sees original model and provider names after renaming configuration and new calls capture the new names', async () => {
        const original = await savedTurn();
        await updateModel({ id: 1, modelPatch: { name: 'Renamed model' } });
        await updateProvider({ id: 1, providerPatch: { name: 'Renamed provider' } });
        const recent = await createSessionTurn({
            model_id: 1,
            task_id: '00000000-0000-4000-8000-000000000002',
            prompt_snapshot_json: '{}',
        });
        expect(
            database
                .prepare('SELECT model_name, provider_name FROM session_turns WHERE id=?')
                .get(original.id)
        ).toMatchObject({ model_name: 'Original model', provider_name: 'Original provider' });
        expect(
            database
                .prepare('SELECT model_name, provider_name FROM session_turns WHERE id=?')
                .get(recent.id)
        ).toMatchObject({ model_name: 'Renamed model', provider_name: 'Renamed provider' });
    });

    it('user keeps historical names in usage trends rankings and context after the provider is removed', async () => {
        await savedTurn();
        await deleteProvider({ id: 1 });
        expect(await getUsageSummary(filter)).toMatchObject({
            requestCount: 1,
            inputTokens: 120,
            outputTokens: 30,
            totalCostMicros: 250000,
        });
        expect((await getUsageTrend(filter)).points.flatMap((point) => point.segments)).toEqual([
            expect.objectContaining({ groupId: null, name: 'Original model', requests: 1 }),
        ]);
        expect(await getUsageByModel(filter)).toEqual([
            expect.objectContaining({ id: null, name: 'Original model', requestCount: 1 }),
        ]);
        expect(await getUsageByProvider(filter)).toEqual([
            expect.objectContaining({ id: null, name: 'Original provider', requestCount: 1 }),
        ]);
        expect(await getModelRanking(filter)).toEqual([
            expect.objectContaining({ id: null, name: 'Original model', requests: 1 }),
        ]);
        expect(await getSessionRanking(filter)).toEqual([
            expect.objectContaining({ subtitle: 'Original model', requests: 1 }),
        ]);
        expect((await getContextProfiles(filter)).models).toEqual([
            expect.objectContaining({ modelName: 'Original model', turnCount: 1 }),
        ]);
        expect(await getContextTurnPoints(filter)).toEqual([
            expect.objectContaining({ modelId: null, promptTokens: 120 }),
        ]);
    });

    it('user can persist known call metadata when its model was removed before the write', async () => {
        await deleteProvider({ id: 1 });
        const session = await createSession({
            session_id: 'started-before-config-removal',
            title: 'Retained request',
            model: 'fixture-model',
            provider_id: 1,
        });
        expect(session.provider_id).toBeNull();
        const turn = await createSessionTurn({
            session_id: session.id,
            model_id: 1,
            model_name: 'Original model',
            provider_name: 'Original provider',
            task_id: '00000000-0000-4000-8000-000000000003',
            prompt_snapshot_json: '{}',
        });
        expect(turn).toMatchObject({
            model_id: null,
            model_name: 'Original model',
            provider_name: 'Original provider',
        });
    });
});
