import type { DatabaseSync } from 'node:sqlite';

import { findMessagesBySessionId } from '@database/queries/messages';
import { createAgentWindowFixture, network, responseFromDeltas } from '@tests/utils/agentWindow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTaskPersistence } from '@/app/workflows/agent/persistence';
import type { PersistenceCheckpoint } from '@/modules/agent';

/**
 * Streamed progress is a replaceable snapshot written through a bounded writer.
 * The attempt boundary is authoritative: a snapshot that belongs to a finished
 * attempt must never be written into the next attempt's message, and no snapshot
 * may land after the step's authoritative write.
 */
function createProjector() {
    return createTaskPersistence({
        sessionId: 1,
        model: { id: 1, provider_id: 1, model_id: 'fixture-model' },
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

function createCheckpoint(): PersistenceCheckpoint {
    return {
        activeModel: { id: 1 },
        messages: [{ role: 'user' }],
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
    let fixture: ReturnType<typeof createAgentWindowFixture>;

    beforeEach(async () => {
        fixture = createAgentWindowFixture();
        database = fixture.database;
        await fixture.window.ready;
        database.exec(`
            INSERT INTO sessions (id, session_id, title, model, provider_id)
            VALUES (1, 'test-session', 'Test', 'fixture-model', 1);
        `);
    });

    afterEach(async () => {
        await fixture.window.dispose();
        vi.restoreAllMocks();
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
        vi.useFakeTimers();
        network.replies.push(
            responseFromDeltas([{ role: 'assistant', content: 'Hello' }, { content: ' world' }])
        );
        const started = await fixture.window.api.startTask({ sessionId: 1, prompt: 'hello' });
        expect((await started.completion).response).toBe('Hello world');

        // Once the step returns, its writer is closed: no late snapshot can land.
        const messagesAfterReturn = await findMessagesBySessionId(1);
        expect(messagesAfterReturn[1]!.parts.map((part) => part.type)).toEqual([
            'text',
            'llm_call',
        ]);
        expect(messagesAfterReturn[1]!.parts.find((part) => part.type === 'text')).toMatchObject({
            content: 'Hello world',
        });
        await vi.advanceTimersByTimeAsync(1000);
        expect(await findMessagesBySessionId(1)).toEqual(messagesAfterReturn);
    });
});
