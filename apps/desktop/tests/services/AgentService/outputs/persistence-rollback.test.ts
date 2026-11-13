import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import type { AttemptCheckpoint } from '@/services/AgentService/execution/executor';
import { PersistenceProjector } from '@/services/AgentService/outputs/persistence';

afterEach(closeTestDatabases);

function persistProgress(
    projector: PersistenceProjector,
    parts: Parameters<PersistenceProjector['persistOutputProgress']>[0]
) {
    return projector.persistOutputProgress(parts, {
        attemptGeneration: projector.getAttemptGeneration(),
        step: 0,
    });
}

async function startTurn() {
    const database = openMigratedDatabase();
    let failCommit = false;
    routeQueriesTo(database, {
        beforeCommit: () => {
            if (failCommit) {
                failCommit = false;
                throw new Error('injected commit failure');
            }
        },
    });
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'Test', 'openai', 'https://example.com', 'openai');
        INSERT INTO models (id, provider_id, name, model_id)
        VALUES (1, 1, 'Test', 'test-model');
        INSERT INTO sessions (id, session_id, title, model, provider_id)
        VALUES (1, 'test-session', 'Test', 'test-model', 1);
    `);
    const projector = new PersistenceProjector({
        sessionId: 1,
        model: { id: 1, provider_id: 1, model_id: 'test-model' },
        taskId: 'test-task',
        executionMode: 'foreground',
        prompt: 'hello',
        maxRetries: 1,
        buildSessionTitle: (prompt) => prompt,
        promptSnapshot: {
            id: 'test-prompt',
            createdAt: '2026-11-06T00:00:00Z',
            systemPrompt: '',
            executionMode: 'foreground',
            fragments: [],
            userPrompt: 'hello',
            attachments: [],
            modelLanguageContext: { locale: 'en-US', label: 'English' },
        },
    });
    const checkpoint: AttemptCheckpoint = {
        activeModel: {
            id: 1,
            provider_id: 1,
            model_id: 'test-model',
        } as AttemptCheckpoint['activeModel'],
        messages: [{ role: 'user', content: 'hello' }],
        response: '',
        reasoning: '',
        outputParts: [],
        iteration: 0,
        modelSwitchCount: 0,
        executedBuiltInToolIds: [],
        modelLanguageContext: { locale: 'en-US', label: 'English' },
    };
    await projector.recordTurnStart(checkpoint);
    await persistProgress(projector, [{ type: 'text', content: 'old' }]);

    const readOutput = () =>
        database
            .prepare(
                `
            SELECT p.content, t.status FROM session_turns t
            JOIN message_parts p ON p.message_id = t.response_message_id
            WHERE t.task_id = 'test-task' AND p.type = 'text'
        `
            )
            .get();

    return {
        database,
        projector,
        readOutput,
        failNextCommit: () => {
            failCommit = true;
        },
    };
}

describe.each(['commit', 'summary'] as const)(
    'given a streamed write fails during %s',
    (failure) => {
        it.each(['completed', 'cancelled', 'failed', 'streaming'] as const)(
            'user retains the latest answer when the next save is %s',
            async (status) => {
                const { database, projector, readOutput, failNextCommit } = await startTurn();
                const finalParts = [{ type: 'text' as const, content: 'new-final' }];
                if (failure === 'commit') {
                    failNextCommit();
                } else {
                    database.exec(`
                    CREATE TEMP TRIGGER reject_summary BEFORE UPDATE ON sessions
                    BEGIN SELECT RAISE(ABORT, 'injected summary failure'); END;
                `);
                }
                const failedWrite = expect(persistProgress(projector, finalParts)).rejects;
                if (failure === 'commit') {
                    await failedWrite.toThrow('injected commit failure');
                } else {
                    await failedWrite.toMatchObject({
                        cause: { message: 'injected summary failure' },
                    });
                }
                expect(readOutput()).toEqual({ content: 'old', status: 'streaming' });
                database.exec('DROP TRIGGER IF EXISTS reject_summary');

                if (status === 'completed') {
                    await projector.markCompleted({ outputParts: finalParts, durationMs: 1 });
                } else if (status === 'cancelled') {
                    await projector.markCancelled(finalParts);
                } else if (status === 'failed') {
                    await projector.markFailed('offline', finalParts);
                } else {
                    await persistProgress(projector, finalParts);
                }
                expect(readOutput()).toEqual({ content: 'new-final', status });
            }
        );
    }
);

describe('given a tool-step write rolls back after streaming', () => {
    it('user retains the latest answer when the task fails after the tool-step write', async () => {
        const { projector, readOutput, failNextCommit } = await startTurn();
        const finalParts = [{ type: 'text' as const, content: 'before tool' }];
        failNextCommit();
        await expect(projector.persistToolCallMessage(finalParts)).rejects.toThrow('injected');
        expect(readOutput()).toEqual({ content: 'old', status: 'streaming' });

        await projector.markFailed('tool step failed', finalParts);
        expect(readOutput()).toEqual({ content: 'before tool', status: 'failed' });
    });
});
