import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import type { PersistenceCheckpoint } from '@/modules/agent';
import { PersistenceProjector } from '@/modules/agent';
import type { PersistenceProjectorHost } from '@/modules/agent/contracts/persistence';

afterEach(closeTestDatabases);

function fixture() {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    database.exec(`INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'Fixture', 'openai', 'https://fixture.invalid', 'openai');
        INSERT INTO models (id, provider_id, name, model_id) VALUES (1, 1, 'Fixture', 'fixture-model');
        INSERT INTO sessions (id, session_id, title, model, provider_id)
        VALUES (1, 'fixture-session', 'Fixture', 'fixture-model', 1);`);
    const promptJson = '{"id":"fixture-prompt","fragments":[],"systemPrompt":"saved instruction"}';
    const manifestJson = '{"version":1,"requests":[]}';
    const host: PersistenceProjectorHost = {
        prepareAttachments: async () => {},
        persistAttachment: async (attachment, store) =>
            (await store.findByHash('fixture-hash')) ??
            store.create({
                hash: 'fixture-hash',
                type: attachment.type,
                original_name: attachment.name,
                origin_path: attachment.originPath,
                mime_type: attachment.mimeType ?? null,
                size: attachment.size ?? null,
            }),
        emptyManifest: () => manifestJson,
        appendManifest: (_current, request) => `{"version":1,"requests":[${request}]}`,
        promptBreakdown: async () => null,
        resolveUsage: async () => ({
            usage: {
                inputTokens: 10,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
            },
            costMicros: 12,
            unpricedCalls: 0,
            parts: [{ data: '{"turnId":1,"costMicros":12}', durationMs: 100, ttftMs: 20 }],
        }),
        diagnostics: { error: () => {}, warn: () => {} },
    };
    const projector = new PersistenceProjector({
        sessionId: 1,
        model: { id: 1, provider_id: 1, model_id: 'fixture-model' },
        taskId: 'fixture-task',
        prompt: 'authorized request',
        executionMode: 'foreground',
        maxRetries: 5,
        buildSessionTitle: (prompt) => prompt,
        promptSnapshotJson: promptJson,
        host,
        attachments: [
            {
                id: 'fixture',
                type: 'file',
                name: 'fixture.txt',
                path: '/fixture/unread',
                originPath: '/fixture/unread',
                mimeType: 'text/plain',
                size: 1,
            },
        ],
    });
    const checkpoint: PersistenceCheckpoint = {
        activeModel: { id: 1 },
        messages: [{ role: 'user' }],
        response: '',
        reasoning: '',
        outputParts: [],
        iteration: 0,
        modelSwitchCount: 0,
        executedBuiltInToolIds: [],
        modelLanguageContext: { locale: 'en-US', label: 'English' },
    };
    return { database, projector, checkpoint, promptJson, manifestJson };
}

describe('given agent persistence receives narrow attachment and consumption capabilities', () => {
    it('user retains the supplied snapshot and delivery bytes while staged resources join the start transaction', async () => {
        const { database, projector, checkpoint, promptJson, manifestJson } = fixture();
        await projector.recordTurnStart(checkpoint);
        expect(database.prepare('SELECT prompt_snapshot_json FROM session_turns').get()).toEqual({
            prompt_snapshot_json: promptJson,
        });
        expect(
            database.prepare('SELECT delivery_manifest_json FROM session_turn_attempts').get()
        ).toEqual({ delivery_manifest_json: manifestJson });
        expect(database.prepare('SELECT hash, origin_path FROM attachments').get()).toEqual({
            hash: 'fixture-hash',
            origin_path: '/fixture/unread',
        });
        expect(
            database
                .prepare("SELECT count(*) AS count FROM message_parts WHERE type = 'attachment'")
                .get()
        ).toEqual({ count: 1 });
        expect(checkpoint.messages[0]?.contextSource?.id).toBeGreaterThan(0);
    });

    it('user retains no staged attachment or history when the same start transaction fails', async () => {
        const { database, projector, checkpoint } = fixture();
        database.exec(`CREATE TEMP TRIGGER reject_start BEFORE INSERT ON session_turn_attempts
            BEGIN SELECT RAISE(ABORT, 'fixture start failure'); END;`);
        await expect(projector.recordTurnStart(checkpoint)).rejects.toThrow();
        expect(database.prepare('SELECT count(*) AS count FROM attachments').get()).toEqual({
            count: 0,
        });
        expect(database.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({
            count: 0,
        });
        expect(projector.getTurn()).toBeNull();
        database.exec('DROP TRIGGER reject_start');
        await projector.recordTurnStart(checkpoint);
        expect(database.prepare('SELECT count(*) AS count FROM attachments').get()).toEqual({
            count: 1,
        });
    });

    it('user keeps consumption parts and aggregates inside a rejected terminal transaction', async () => {
        const { database, projector, checkpoint } = fixture();
        await projector.recordTurnStart(checkpoint);
        const calls = [
            {
                iteration: 0,
                modelId: 1,
                modelName: 'fixture-model',
                providerId: 1,
                providerName: 'Fixture',
                usage: {
                    inputTokens: 10,
                    outputTokens: 2,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    reasoningTokens: 0,
                },
                timing: { durationMs: 100 },
                toolCallsInStep: 0,
                toolArgumentErrors: 0,
            },
        ];
        database.exec(`CREATE TEMP TRIGGER reject_finish BEFORE UPDATE ON session_turns
            WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture finish failure'); END;`);
        await expect(
            projector.markCompleted({
                outputParts: [{ type: 'text', content: 'answer' }],
                durationMs: 1,
                calls,
            })
        ).rejects.toThrow();
        expect(
            database
                .prepare("SELECT count(*) AS count FROM message_parts WHERE type = 'llm_call'")
                .get()
        ).toEqual({ count: 0 });
        expect(
            database.prepare('SELECT total_cost_micros FROM session_turn_attempts').get()
        ).toEqual({ total_cost_micros: 0 });
        database.exec('DROP TRIGGER reject_finish');
        await projector.markCompleted({
            outputParts: [{ type: 'text', content: 'answer' }],
            durationMs: 1,
            calls,
        });
        expect(
            database.prepare("SELECT data FROM message_parts WHERE type = 'llm_call'").get()
        ).toEqual({ data: '{"turnId":1,"costMicros":12}' });
        expect(
            database.prepare('SELECT total_cost_micros FROM session_turn_attempts').get()
        ).toEqual({ total_cost_micros: 12 });
    });
});
