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
    createMessageParts: vi.fn(),
    updateMessage: vi.fn(),
    syncOutputParts: vi.fn(),
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
        outputParts: [],
        iteration: 0,
        modelSwitchCount: 0,
        executedBuiltInToolIds: [],
        modelLanguageContext: { locale: 'zh-CN', label: 'Simplified Chinese' },
    };
}

describe('reasoning persistence', () => {
    it('does not write temporary output to attempts while streaming', async () => {
        queries.updateSessionTurnAttempt.mockClear();
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        queries.updateSessionTurnAttempt.mockClear();
        provider.stream.mockImplementation(async function* () {
            yield { content: '', reasoning: 'Plan', done: false };
            yield { content: '', reasoningState: 'end', done: false };
            yield { content: 'Answer', done: true };
        });
        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: projector,
        });
        expect(result.type).toBe('completed');
        expect(queries.updateSessionTurnAttempt).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            finalStepOutputParts: [
                { type: 'reasoning', content: 'Plan' },
                { type: 'text', content: 'Answer' },
            ],
        });
    });

    beforeEach(() => {
        vi.resetAllMocks();
        let messageId = 10;
        queries.createMessage.mockImplementation(async (draft) => ({ ...draft, id: messageId++ }));
        queries.createSessionTurn.mockImplementation(async (draft) => ({ ...draft, id: 2 }));
        queries.createSessionTurnAttempt.mockImplementation(async (draft) => ({
            ...draft,
            id: 3,
        }));
    });

    it.each(['failed', 'cancelled'] as const)(
        'keeps the assistant link when %s before the first reasoning delta',
        async (status) => {
            const projector = createProjector();
            await projector.recordTurnStart(createCheckpoint());
            const start = { type: 'reasoning' as const, content: '', startedAt: 1000 };
            await projector.persistOutputProgress([start]);
            const closed = [{ ...start, endedAt: 1500 }];
            if (status === 'failed') {
                await projector.markFailed('offline', '', '', [], closed);
            } else {
                await projector.markCancelled('', '', [], closed);
            }
            expect(queries.createMessage).toHaveBeenCalledTimes(2);
            expect(queries.syncOutputParts).toHaveBeenLastCalledWith(
                11,
                [
                    expect.objectContaining({
                        message_id: 11,
                        type: 'reasoning',
                        content: '',
                        started_at: 1000,
                        ended_at: 1500,
                    }),
                ],
                expect.anything()
            );
            expect(queries.updateSessionTurn).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    turnPatch: expect.objectContaining({ status, response_message_id: 11 }),
                })
            );
        }
    );

    it('persists ordered tool-call parts without a temporary attempt snapshot', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        queries.updateSessionTurnAttempt.mockClear();
        const parts = [
            { type: 'reasoning' as const, content: 'Plan', startedAt: 1000, endedAt: 2000 },
            { type: 'text' as const, content: 'Checking' },
        ];
        await projector.persistToolCallMessage('Checking', 'Plan', [], parts);
        expect(queries.updateSessionTurnAttempt).not.toHaveBeenCalled();
        expect(queries.syncOutputParts).toHaveBeenLastCalledWith(
            11,
            [
                {
                    message_id: 11,
                    type: 'reasoning',
                    content: 'Plan',
                    started_at: 1000,
                    ended_at: 2000,
                    sort_order: 0,
                },
                {
                    message_id: 11,
                    type: 'text',
                    content: 'Checking',
                    started_at: null,
                    ended_at: null,
                    sort_order: 1,
                },
            ],
            {}
        );
    });

    it.each(['failed', 'cancelled'] as const)(
        'commits partial ordered output on %s without a temporary snapshot',
        async (status) => {
            const projector = createProjector();
            await projector.recordTurnStart(createCheckpoint());
            const parts = [
                { type: 'reasoning' as const, content: 'Plan', startedAt: 1000, endedAt: 2000 },
                { type: 'text' as const, content: 'Partial answer' },
            ];
            if (status === 'failed') {
                await projector.markFailed('Offline', 'Partial answer', 'Plan', [], parts);
            } else {
                await projector.markCancelled('Partial answer', 'Plan', [], parts);
            }
            expect(queries.syncOutputParts).toHaveBeenLastCalledWith(
                11,
                [
                    {
                        message_id: 11,
                        type: 'reasoning',
                        content: 'Plan',
                        started_at: 1000,
                        ended_at: 2000,
                        sort_order: 0,
                    },
                    {
                        message_id: 11,
                        type: 'text',
                        content: 'Partial answer',
                        started_at: null,
                        ended_at: null,
                        sort_order: 1,
                    },
                ],
                {}
            );
        }
    );

    it('persists wall-clock boundaries in the completed message', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const completed = [{ content: 'Thought', startedAt: 1000, endedAt: 6500 }];
        await projector.markCompleted({
            response: 'Answer',
            reasoning: 'Thought',
            durationMs: 6000,
            outputParts: [
                { type: 'reasoning', ...completed[0]! },
                { type: 'text', content: 'Answer' },
            ],
        });
        expect(queries.syncOutputParts).toHaveBeenLastCalledWith(
            11,
            [
                {
                    message_id: 11,
                    type: 'reasoning',
                    content: 'Thought',
                    started_at: 1000,
                    ended_at: 6500,
                    sort_order: 0,
                },
                {
                    message_id: 11,
                    type: 'text',
                    content: 'Answer',
                    started_at: null,
                    ended_at: null,
                    sort_order: 1,
                },
            ],
            {}
        );
    });

    it('reuses the streaming message when completing a turn', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const thought = {
            type: 'reasoning' as const,
            content: 'Plan',
            startedAt: 1000,
            endedAt: 2000,
        };
        await projector.persistOutputProgress([thought]);
        await projector.markCompleted({
            response: 'Answer',
            reasoning: 'Plan',
            durationMs: 5000,
            outputParts: [thought, { type: 'text', content: 'Answer' }],
        });
        expect(queries.createMessage).toHaveBeenCalledTimes(2); // prompt + one assistant
        expect(queries.updateMessage).toHaveBeenCalledWith(
            11,
            expect.objectContaining({ role: 'assistant' }),
            {}
        );
        expect(queries.syncOutputParts).toHaveBeenCalledTimes(2);
        expect(queries.syncOutputParts).toHaveBeenLastCalledWith(
            11,
            expect.arrayContaining([
                expect.objectContaining({ message_id: 11, type: 'text', content: 'Answer' }),
            ]),
            {}
        );
        expect(queries.updateSessionTurn).toHaveBeenLastCalledWith(
            expect.objectContaining({
                turnPatch: expect.objectContaining({
                    response_message_id: 11,
                    status: 'completed',
                }),
            })
        );
    });

    it('reuses the streaming message as a tool-call step without leaking it into the final reply', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const parts = [
            { type: 'reasoning' as const, content: 'Plan', startedAt: 1000, endedAt: 2000 },
        ];
        await projector.persistOutputProgress(parts);
        expect(await projector.persistToolCallMessage('', 'Plan', [], parts)).toBe(11);
        await projector.markCompleted({
            response: 'Answer',
            reasoning: '',
            durationMs: 5000,
            outputParts: [{ type: 'text', content: 'Answer' }],
        });
        expect(queries.createMessage).toHaveBeenCalledTimes(3); // prompt, tool step, final reply
        expect(queries.updateMessage).toHaveBeenCalledWith(
            11,
            expect.objectContaining({ role: 'tool_call' }),
            {}
        );
    });

    it('updates only the checkpoint at a safe boundary', async () => {
        const projector = createProjector();
        const checkpoint = createCheckpoint();
        await projector.recordTurnStart(checkpoint);
        await projector.persistCheckpoint(checkpoint);
        expect(queries.updateSessionTurnAttempt).toHaveBeenLastCalledWith({
            id: 3,
            attemptPatch: { checkpoint_json: expect.any(String) },
            database: {},
        });
    });
});
