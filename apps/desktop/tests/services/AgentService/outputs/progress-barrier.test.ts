import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const queries = vi.hoisted(() => ({
    createMessage: vi.fn(),
    createMessageParts: vi.fn(),
    updateMessage: vi.fn(),
    syncOutputParts: vi.fn(),
    createSessionTurn: vi.fn(),
    createSessionTurnAttempt: vi.fn(),
    updateSession: vi.fn(),
    updateSessionTurn: vi.fn(),
    updateSessionTurnAttempt: vi.fn(),
    updateSessionTurnUsage: vi.fn(),
    refreshSessionMetadata: vi.fn(),
    mergeMessagePartData: vi.fn(),
    findToolCallPartByCallId: vi.fn(),
    createMessageAttachment: vi.fn(),
}));

vi.mock('@database', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@database')>()),
    db: { transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({}) },
}));
vi.mock('@database/queries', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@database/queries')>()),
    ...queries,
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
    beforeEach(() => {
        vi.resetAllMocks();
        let messageId = 10;
        queries.createMessage.mockImplementation(async (draft) => ({ ...draft, id: messageId++ }));
        queries.createSessionTurn.mockImplementation(async (draft) => ({ ...draft, id: 2 }));
        queries.createSessionTurnAttempt.mockImplementation(async (draft) => ({
            ...draft,
            attempt_index: draft.attempt_index,
            id: 3,
        }));
    });

    it('user does not see a stale progress snapshot written into the new attempt', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const staleGeneration = projector.getAttemptGeneration();

        // A retry moves the projector to a new attempt before the stale write lands.
        await projector.beginNextAttempt('offline', createCheckpoint());
        queries.syncOutputParts.mockClear();

        await projector.persistOutputProgress([{ type: 'text', content: 'stale output' }], {
            attemptGeneration: staleGeneration,
            step: 0,
        });
        expect(queries.syncOutputParts).not.toHaveBeenCalled();

        // A write scoped to the current attempt still lands.
        await projector.persistOutputProgress([{ type: 'text', content: 'fresh output' }], {
            attemptGeneration: projector.getAttemptGeneration(),
            step: 0,
        });
        expect(queries.syncOutputParts).toHaveBeenCalledWith(
            expect.anything(),
            [expect.objectContaining({ type: 'text', content: 'fresh output' })],
            expect.anything()
        );
    });

    it('user does not see a snapshot from an older model step after a newer one wrote', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const generation = projector.getAttemptGeneration();

        await projector.persistOutputProgress([{ type: 'text', content: 'step 1' }], {
            attemptGeneration: generation,
            step: 1,
        });
        queries.syncOutputParts.mockClear();

        await projector.persistOutputProgress([{ type: 'text', content: 'late step 0' }], {
            attemptGeneration: generation,
            step: 0,
        });
        expect(queries.syncOutputParts).not.toHaveBeenCalled();
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
        const callsAfterReturn = queries.syncOutputParts.mock.calls.length;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(queries.syncOutputParts.mock.calls.length).toBe(callsAfterReturn);
    });
});
