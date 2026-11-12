import type { DatabaseSync } from 'node:sqlite';

import { findMessagesBySessionId } from '@database/queries/messages';
import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiRequestExecutor } from '@/services/AgentService/execution';
import type { AttemptCheckpoint } from '@/services/AgentService/execution/executor';
import { PersistenceProjector } from '@/services/AgentService/outputs/persistence';

/**
 * Streamed progress is a replaceable snapshot written through a bounded writer.
 * The attempt boundary is authoritative: a snapshot that belongs to a finished
 * attempt must never be written into the next attempt's message, and no snapshot
 * may land after the step's authoritative write.
 */
const provider = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@/services/AgentService/catalog', () => ({
    createProviderForModel: vi.fn(() => provider),
    resolveToolDefinitions: vi.fn(async () => []),
    getModel: vi.fn(),
}));

function createProjector() {
    return new PersistenceProjector({
        sessionId: 1,
        model: { id: 1, provider_id: 1, model_id: 'test-model' },
        taskId: 'task-1',
        executionMode: 'foreground',
        prompt: 'hello',
        maxRetries: 3,
        buildSessionTitle: (prompt) => prompt,
        promptSnapshot: {
            id: 'prompt-1',
            createdAt: '2026-10-08T00:00:00Z',
            systemPrompt: '',
            executionMode: 'foreground',
            fragments: [],
            userPrompt: 'hello',
            attachments: [],
            modelLanguageContext: { locale: 'zh-CN', label: 'Simplified Chinese' },
        },
    });
}

function createCheckpoint(): AttemptCheckpoint {
    return {
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
        modelLanguageContext: { locale: 'zh-CN', label: 'Simplified Chinese' },
    };
}

describe('user streams progress across an attempt boundary', () => {
    let database: DatabaseSync;

    beforeEach(() => {
        provider.stream.mockReset();
        database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO providers (id, name, driver, api_endpoint, logo)
            VALUES (1, 'Test', 'openai', 'https://example.com', 'openai');
            INSERT INTO models (id, provider_id, name, model_id)
            VALUES (1, 1, 'Test', 'test-model');
            INSERT INTO sessions (id, session_id, title, model, provider_id)
            VALUES (1, 'test-session', 'Test', 'test-model', 1);
        `);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        closeTestDatabases();
    });

    it('user does not see a stale progress snapshot written into the new attempt', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const staleGeneration = projector.getAttemptGeneration();

        // A retry moves the projector to a new attempt before the stale write lands.
        await projector.beginNextAttempt('offline', createCheckpoint());

        await projector.persistOutputProgress([{ type: 'text', content: 'stale output' }], {
            attemptGeneration: staleGeneration,
            step: 0,
        });
        expect(await findMessagesBySessionId(1)).toHaveLength(1);

        // A write scoped to the current attempt still lands.
        await projector.persistOutputProgress([{ type: 'text', content: 'fresh output' }], {
            attemptGeneration: projector.getAttemptGeneration(),
            step: 0,
        });
        const messages = await findMessagesBySessionId(1);
        expect(messages).toHaveLength(2);
        expect(messages[1]!.parts).toMatchObject([{ type: 'text', content: 'fresh output' }]);
    });

    it('user does not see a snapshot from an older model step after a newer one wrote', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const generation = projector.getAttemptGeneration();

        await projector.persistOutputProgress([{ type: 'text', content: 'step 1' }], {
            attemptGeneration: generation,
            step: 1,
        });

        await projector.persistOutputProgress([{ type: 'text', content: 'late step 0' }], {
            attemptGeneration: generation,
            step: 0,
        });
        const messages = await findMessagesBySessionId(1);
        expect(messages).toHaveLength(2);
        expect(messages[1]!.parts).toMatchObject([{ type: 'text', content: 'step 1' }]);
    });

    it('user sees no snapshot written after the model step closes', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        provider.stream.mockImplementation(async function* () {
            yield { content: 'Hello', done: false };
            yield { content: ' world', textState: 'end', done: false };
            yield { content: '', done: true };
        });

        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: projector,
            taskId: 'task-1',
            attemptToken: 'attempt-1',
        });

        expect(result.type).toBe('completed');
        expect((result as { finalStepOutputParts: unknown }).finalStepOutputParts).toEqual([
            { type: 'text', content: 'Hello world' },
        ]);

        // Once the step returns, its writer is closed: no late snapshot can land.
        const messagesAfterReturn = await findMessagesBySessionId(1);
        expect(messagesAfterReturn[1]!.parts).toMatchObject([
            { type: 'text', content: 'Hello world' },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(await findMessagesBySessionId(1)).toEqual(messagesAfterReturn);
    });
});
