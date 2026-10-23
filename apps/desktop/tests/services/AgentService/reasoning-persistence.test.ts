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
    appendMessagePart: vi.fn(),
    findToolCallPartByCallId: vi.fn(),
    mergeMessagePartData: vi.fn(),
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

describe('reasoning and the answer are saved as they stream', () => {
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
    it('user sees no temporary attempt output written while streaming', async () => {
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

    it.each(['failed', 'cancelled'] as const)(
        'user keeps the assistant link when the turn is %s before the first reasoning delta',
        async (status) => {
            const projector = createProjector();
            await projector.recordTurnStart(createCheckpoint());
            const start = { type: 'reasoning' as const, content: '', startedAt: 1000 };
            await projector.persistOutputProgress([start]);
            const closed = [{ ...start, endedAt: 1500 }];
            if (status === 'failed') {
                await projector.markFailed('offline', closed);
            } else {
                await projector.markCancelled(closed);
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

    it('user sees ordered tool-call parts saved without a temporary snapshot', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        queries.updateSessionTurnAttempt.mockClear();
        const parts = [
            { type: 'reasoning' as const, content: 'Plan', startedAt: 1000, endedAt: 2000 },
            { type: 'text' as const, content: 'Checking' },
        ];
        await projector.persistToolCallMessage(parts);
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
        'user keeps partial ordered output when the turn is %s without a temporary snapshot',
        async (status) => {
            const projector = createProjector();
            await projector.recordTurnStart(createCheckpoint());
            const parts = [
                { type: 'reasoning' as const, content: 'Plan', startedAt: 1000, endedAt: 2000 },
                { type: 'text' as const, content: 'Partial answer' },
            ];
            if (status === 'failed') {
                await projector.markFailed('Offline', parts);
            } else {
                await projector.markCancelled(parts);
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

    it.each(['failed', 'cancelled'] as const)(
        'user keeps durable output when the turn is %s without a final snapshot',
        async (status) => {
            const projector = createProjector();
            await projector.recordTurnStart(createCheckpoint());
            await projector.persistOutputProgress([
                { type: 'reasoning', content: 'Saved thought', startedAt: 1000, endedAt: 2000 },
                { type: 'text', content: 'Saved answer' },
            ]);
            queries.syncOutputParts.mockClear();
            if (status === 'failed') {
                await projector.markFailed('Unexpected runtime error');
            } else {
                await projector.markCancelled();
            }
            expect(queries.syncOutputParts).not.toHaveBeenCalled();
            expect(queries.updateSessionTurn).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    turnPatch: expect.objectContaining({ status, response_message_id: 11 }),
                })
            );
        }
    );

    it('user sees wall-clock boundaries saved in the completed message', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const completed = [{ content: 'Thought', startedAt: 1000, endedAt: 6500 }];
        await projector.markCompleted({
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

    it('user sees the streaming message reused when the turn completes', async () => {
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

    it('user keeps streamed output when completion brings no final parts', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        await projector.persistOutputProgress([
            { type: 'reasoning', content: 'Saved thought', startedAt: 1000, endedAt: 2000 },
        ]);
        queries.syncOutputParts.mockClear();

        await projector.markCompleted({ durationMs: 5000, outputParts: [] });

        expect(queries.syncOutputParts).not.toHaveBeenCalled();
        expect(queries.updateSessionTurn).toHaveBeenLastCalledWith(
            expect.objectContaining({
                turnPatch: expect.objectContaining({
                    response_message_id: 11,
                    status: 'completed',
                }),
            })
        );
    });

    it('user sees the streaming message reused as a tool-call step without leaking into the reply', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const parts = [
            { type: 'reasoning' as const, content: 'Plan', startedAt: 1000, endedAt: 2000 },
        ];
        await projector.persistOutputProgress(parts);
        expect(await projector.persistToolCallMessage(parts)).toBe(11);
        await projector.markCompleted({
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

    it('user sees the tool result written back into its tool-call part', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        queries.mergeMessagePartData.mockResolvedValue({
            id: 42,
            message_id: 11,
            tool_call_id: 'call-1',
            tool_kind: 'builtin',
        });

        await projector.persistToolResult({
            result: 'done',
            toolCallPartId: 42,
            toolCallMessageId: 11,
        });

        expect(queries.mergeMessagePartData).toHaveBeenCalledWith(
            42,
            { output: 'done' },
            expect.anything()
        );
        expect(queries.refreshSessionMetadata).toHaveBeenLastCalledWith(1, expect.anything());
    });

    it('user sees tool-result attachments saved with their owning call', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        queries.mergeMessagePartData.mockResolvedValue({
            id: 42,
            message_id: 11,
            tool_call_id: 'call-1',
            tool_kind: 'mcp',
        });
        queries.createMessageAttachment.mockResolvedValue({ id: 5 });

        await projector.persistToolResult({
            result: 'file ready',
            toolCallPartId: 42,
            toolCallMessageId: 11,
            attachments: [
                {
                    id: 'attachment-1',
                    attachmentId: 7,
                    hash: 'hash-7',
                    type: 'file',
                    path: 'D:/cache/seven.txt',
                    originPath: 'D:/origin/seven.txt',
                    name: 'seven.txt',
                },
            ],
        });

        expect(queries.createMessageAttachment).toHaveBeenCalledWith(
            {
                message_id: 11,
                attachment_id: 7,
                origin_path: 'D:/origin/seven.txt',
                tool_call_id: 'call-1',
                tool_kind: 'mcp',
            },
            expect.anything()
        );
    });

    it('user sees the tool-call part recovered by call id instead of as assistant text', async () => {
        // 工具结果只能落在 tool_call 片段上。主键丢了就按 tool_call_id 反查，
        // 绝不把结果写成一条助手文本（那会在对话里渲染成大段原始工具输出）。
        queries.findToolCallPartByCallId.mockResolvedValueOnce({ id: 77 } as never);
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.persistToolResult({
            result: 'recovered output',
            toolCallId: 'call-77',
            toolCallPartId: null,
            toolCallMessageId: 11,
        });

        // 只在拿到消息 id 时才反查，避免命中更早消息里的同 id 片段。
        expect(queries.findToolCallPartByCallId).toHaveBeenCalledWith('call-77', 11);
        expect(queries.mergeMessagePartData).toHaveBeenCalledWith(
            77,
            { output: 'recovered output' },
            expect.anything()
        );
        expect(queries.appendMessagePart).not.toHaveBeenCalled();
    });

    it('user sees no call-id lookup when the tool-call message is unknown', async () => {
        // 没有消息 id 就不做不限定的反查：`tool_call_id` 只保证在单条消息内唯一，
        // 命中了更早消息里的同 id 片段会把结果写错地方。
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.persistToolResult({
            result: 'no message to attach to',
            toolCallId: 'call-77',
            toolCallPartId: null,
            toolCallMessageId: null,
        });

        expect(queries.findToolCallPartByCallId).not.toHaveBeenCalled();
        expect(queries.mergeMessagePartData).not.toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    it('user sees an unmatched tool result dropped rather than stored as assistant text', async () => {
        queries.findToolCallPartByCallId.mockResolvedValueOnce(undefined as never);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.persistToolResult({
            result: 'unmatched output',
            toolCallId: 'call-missing',
            toolCallPartId: null,
            toolCallMessageId: 11,
        });

        expect(queries.appendMessagePart).not.toHaveBeenCalled();
        expect(queries.mergeMessagePartData).not.toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    it('user sees an unmatched empty tool result ignored', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.persistToolResult({
            result: '',
            toolCallPartId: null,
            toolCallMessageId: 11,
        });

        expect(queries.appendMessagePart).not.toHaveBeenCalled();
    });

    it('user sees only the checkpoint updated at a safe boundary', async () => {
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

    it('user sees reasoning provider options saved into the message part', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        await projector.markCompleted({
            durationMs: 5000,
            outputParts: [
                {
                    type: 'reasoning',
                    content: 'Thought',
                    startedAt: 1000,
                    endedAt: 6500,
                    providerOptions: {
                        openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc' },
                    },
                },
                { type: 'text', content: 'Answer' },
            ],
        });
        expect(queries.syncOutputParts).toHaveBeenLastCalledWith(
            11,
            [
                expect.objectContaining({
                    message_id: 11,
                    type: 'reasoning',
                    content: 'Thought',
                    data: JSON.stringify({
                        openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc' },
                    }),
                }),
                expect.objectContaining({ message_id: 11, type: 'text', content: 'Answer' }),
            ],
            {}
        );
    });
});
