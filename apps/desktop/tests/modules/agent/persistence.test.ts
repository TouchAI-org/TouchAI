import type { DatabaseSync } from 'node:sqlite';

import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import { createTaskPersistence } from '@/app/workflows/agent/persistence';
import type { PersistenceCheckpoint } from '@/modules/agent';

afterEach(closeTestDatabases);

function fixture(options: { newSession?: boolean; beforeCommit?: () => void } = {}) {
    const database = openMigratedDatabase();
    routeQueriesTo(database, { beforeCommit: options.beforeCommit });
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'Fixture', 'openai', 'https://fixture.invalid', 'openai');
        INSERT INTO models (id, provider_id, name, model_id) VALUES (1, 1, 'Fixture', 'fixture-model');
        INSERT INTO sessions (id, session_id, title, model, provider_id)
        VALUES (1, 'fixture-session', 'Fixture', 'fixture-model', 1);
    `);
    if (options.newSession) database.exec('DELETE FROM sessions');
    const projector = createTaskPersistence({
        sessionId: options.newSession ? undefined : 1,
        model: { id: 1, provider_id: 1, model_id: 'fixture-model' },
        taskId: 'fixture-task',
        executionMode: 'foreground',
        prompt: 'authorized request',
        maxRetries: 5,
        buildSessionTitle: (prompt) => prompt,
        promptSnapshot: {
            id: 'fixture-prompt',
            createdAt: '2026-11-15T00:00:00Z',
            systemPrompt: '',
            executionMode: 'foreground',
            fragments: [],
            userPrompt: 'authorized request',
            attachments: [],
            modelLanguageContext: { locale: 'en-US', label: 'English' },
        },
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
    return { database, projector, checkpoint };
}

function state(database: DatabaseSync) {
    return database
        .prepare(
            `SELECT t.status AS turnStatus, a.status AS attemptStatus, p.content
        FROM session_turns t JOIN session_turn_attempts a ON a.turn_id = t.id
        LEFT JOIN message_parts p ON p.message_id = t.response_message_id AND p.type = 'text'
        WHERE t.task_id = 'fixture-task'`
        )
        .get();
}

describe('given an atomic Desktop persistence barrier rejects a storage write', () => {
    it('user does not retain a newly created session identity after its start transaction fails to commit', async () => {
        let failCommit = true;
        const { database, projector, checkpoint } = fixture({
            newSession: true,
            beforeCommit: () => {
                if (failCommit) throw new Error('fixture start commit failure');
            },
        });
        await expect(projector.recordTurnStart(checkpoint)).rejects.toThrow(
            'fixture start commit failure'
        );
        expect(projector.getSessionId()).toBeNull();
        expect(projector.getTurn()).toBeNull();
        expect(database.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({
            count: 0,
        });
        failCommit = false;
        await projector.recordTurnStart(checkpoint);
        expect(projector.getSessionId()).toBeGreaterThan(0);
        expect(state(database)).toEqual({
            turnStatus: 'streaming',
            attemptStatus: 'streaming',
            content: null,
        });
    });

    it('user does not see terminal success or partial records when the status update fails', async () => {
        const { database, projector, checkpoint } = fixture();
        await projector.recordTurnStart(checkpoint);
        await projector.persistOutputProgress([{ type: 'text', content: 'committed progress' }], {
            attemptGeneration: projector.getAttemptGeneration(),
            step: 0,
        });
        database.exec(`CREATE TEMP TRIGGER reject_terminal BEFORE UPDATE ON session_turns
            WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture terminal failure'); END;`);
        await expect(
            projector.markCompleted({
                outputParts: [{ type: 'text', content: 'final answer' }],
                durationMs: 1,
            })
        ).rejects.toThrow();
        expect(state(database)).toEqual({
            turnStatus: 'streaming',
            attemptStatus: 'streaming',
            content: 'committed progress',
        });
        expect(projector.getTurn()?.status).toBe('streaming');
        database.exec('DROP TRIGGER reject_terminal');
        await projector.markCompleted({
            outputParts: [{ type: 'text', content: 'final answer' }],
            durationMs: 1,
        });
        expect(state(database)).toEqual({
            turnStatus: 'completed',
            attemptStatus: 'completed',
            content: 'final answer',
        });
    });

    it('user does not start from an uncommitted session identity and can start after the storage fault is removed', async () => {
        const { database, projector, checkpoint } = fixture();
        database.exec(`CREATE TEMP TRIGGER reject_identity BEFORE UPDATE OF model ON sessions
            BEGIN SELECT RAISE(ABORT, 'fixture identity failure'); END;`);
        await expect(projector.recordTurnStart(checkpoint)).rejects.toThrow();
        expect(database.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({
            count: 0,
        });
        expect(database.prepare('SELECT count(*) AS count FROM session_turns').get()).toEqual({
            count: 0,
        });
        expect(projector.getTurn()).toBeNull();
        expect(projector.getAttemptGeneration()).toBe(0);
        database.exec('DROP TRIGGER reject_identity');
        await projector.recordTurnStart(checkpoint);
        expect(state(database)).toEqual({
            turnStatus: 'streaming',
            attemptStatus: 'streaming',
            content: null,
        });
    });

    it('user receives a failed-save outcome instead of losing a result whose call record is missing', async () => {
        const { database, projector, checkpoint } = fixture();
        await projector.recordTurnStart(checkpoint);
        await expect(
            projector.persistToolResult({
                result: 'external effect completed',
                toolCallId: 'missing-call',
                toolCallPartId: null,
                toolCallMessageId: null,
            })
        ).rejects.toThrow('TOOL_RESULT_TARGET_MISSING');
        expect(
            database
                .prepare(
                    "SELECT count(*) AS count FROM message_parts WHERE content = 'external effect completed'"
                )
                .get()
        ).toEqual({ count: 0 });
        expect(state(database)?.turnStatus).toBe('streaming');
    });
});
