import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiRequestExecutor } from '@/services/AgentService/execution';
import type { AttemptCheckpoint } from '@/services/AgentService/execution/executor';
import { PersistenceProjector } from '@/services/AgentService/outputs/persistence';

const provider = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@/services/AgentService/catalog', () => ({
    createProviderForModel: vi.fn(() => provider),
    resolveToolDefinitions: vi.fn(async () => []),
    getModel: vi.fn(),
}));

const queries = vi.hoisted(() => ({
    createMessage: vi.fn(),
    createSessionTurn: vi.fn(),
    createSessionTurnAttempt: vi.fn(),
    updateSession: vi.fn(),
    updateSessionTurn: vi.fn(),
    updateSessionTurnAttempt: vi.fn(),
    refreshSessionMetadata: vi.fn(),
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
        iteration: 0,
        modelSwitchCount: 0,
        executedBuiltInToolIds: [],
        modelLanguageContext: { locale: 'zh-CN', label: 'Simplified Chinese' },
    };
}

describe('reasoning persistence', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        let messageId = 10;
        queries.createMessage.mockImplementation(async (draft) => ({ ...draft, id: messageId++ }));
        queries.createSessionTurn.mockImplementation(async (draft) => ({ ...draft, id: 2 }));
        queries.createSessionTurnAttempt.mockImplementation(async (draft) => ({
            ...draft,
            id: 3,
            reasoning_progress_json: null,
        }));
    });

    it.each(['output', 'legacy reasoning'] as const)(
        'preserves the real projector receiver when saving %s progress from the executor',
        async (mode) => {
            const projector = createProjector();
            await projector.recordTurnStart(createCheckpoint());
            if (mode === 'legacy reasoning') {
                Object.defineProperty(projector, 'persistOutputProgress', { value: undefined });
            }
            queries.updateSessionTurnAttempt.mockClear();
            provider.stream.mockImplementation(async function* () {
                yield { content: '', reasoning: 'Plan', done: false };
                yield { content: '', reasoningState: 'end', done: false };
                yield { content: 'Answer', done: true };
            });
            const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
            const result = await new AiRequestExecutor().runAttempt({
                startCheckpoint: createCheckpoint(),
                persister: projector,
            });

            expect(result.type).toBe('completed');
            expect(errors).not.toHaveBeenCalled();
            expect(queries.updateSessionTurnAttempt).toHaveBeenCalledWith({
                id: 3,
                attemptPatch: { reasoning_progress_json: expect.any(String) },
            });
            const writes = queries.updateSessionTurnAttempt.mock.calls.map(([args]) =>
                JSON.parse(args.attemptPatch.reasoning_progress_json)
            );
            const thought = {
                content: 'Plan',
                startedAt: expect.any(Number),
                endedAt: expect.any(Number),
            };
            expect(writes[0]).toMatchObject(
                mode === 'output'
                    ? { version: 2, parts: [{ type: 'reasoning', ...thought }] }
                    : { segments: [thought] }
            );
            if (mode === 'output') {
                expect(writes[writes.length - 1].parts).toMatchObject([
                    { type: 'reasoning', ...thought },
                    { type: 'text', content: 'Answer' },
                ]);
            }
        }
    );

    it('saves answer text without rewriting the full checkpoint', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        await projector.persistOutputProgress('Partial answer', [], 6000);
        expect(queries.updateSessionTurnAttempt).toHaveBeenLastCalledWith({
            id: 3,
            attemptPatch: {
                reasoning_progress_json: JSON.stringify({
                    response: 'Partial answer',
                    segments: [],
                    savedAt: 6000,
                }),
            },
        });
    });

    it('clears temporary output atomically when handing it off to a tool-call message', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const parts = [
            { type: 'reasoning' as const, content: 'Plan', startedAt: 1000, endedAt: 2000 },
            { type: 'text' as const, content: 'Checking' },
        ];
        await projector.persistOutputProgress(parts, 2500);
        await projector.persistToolCallMessage('Checking', 'Plan', [], parts);
        expect(queries.updateSessionTurnAttempt).toHaveBeenLastCalledWith({
            id: 3,
            attemptPatch: { reasoning_progress_json: null },
            database: expect.any(Object),
        });
        const toolCall = queries.createMessage.mock.calls.find(
            ([draft]) => draft.role === 'tool_call'
        )!;
        expect(JSON.parse(toolCall[0].reasoning_meta)).toEqual({ version: 2, parts });
        expect(toolCall[1]).toBe(
            queries.updateSessionTurnAttempt.mock.calls[
                queries.updateSessionTurnAttempt.mock.calls.length - 1
            ]![0].database
        );
    });

    it('updates only the reasoning snapshot during streaming and persists wall-clock boundaries in the final message', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const active = [{ content: 'Thought', startedAt: 1000 }];
        await projector.persistReasoningProgress(active, 6000);
        expect(queries.updateSessionTurnAttempt).toHaveBeenLastCalledWith({
            id: 3,
            attemptPatch: {
                reasoning_progress_json: JSON.stringify({ segments: active, savedAt: 6000 }),
            },
        });
        const completed = [{ content: 'Thought', startedAt: 1000, endedAt: 6500 }];
        await projector.markCompleted({
            response: 'Answer',
            reasoning: 'Thought',
            durationMs: 6000,
            reasoningSegments: completed,
        });
        const assistantDraft = queries.createMessage.mock.calls.find(
            ([draft]) => draft.role === 'assistant'
        )?.[0];
        expect(JSON.parse(assistantDraft.reasoning_meta)).toEqual(completed);
        expect(assistantDraft.reasoning_meta).not.toContain('durationMs');
    });

    it('clears the temporary snapshot only when committing a safe checkpoint', async () => {
        const projector = createProjector();
        const checkpoint = createCheckpoint();
        await projector.recordTurnStart(checkpoint);
        await projector.persistReasoningProgress([{ content: 'Thought', startedAt: 1000 }], 6000);
        await projector.persistCheckpoint(checkpoint);
        expect(queries.updateSessionTurnAttempt).toHaveBeenLastCalledWith({
            id: 3,
            attemptPatch: {
                checkpoint_json: expect.any(String),
                reasoning_progress_json: null,
            },
            database: {},
        });
    });
});
