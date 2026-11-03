import type { DatabaseSync } from 'node:sqlite';

import { createAttachmentRecord } from '@database/queries/attachments';
import { findMessagesBySessionId } from '@database/queries/messages';
import { createToolPart, findToolPartById } from '@database/queries/toolParts';
import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiRequestExecutor } from '@/services/AgentService/execution';
import type { AttemptCheckpoint } from '@/services/AgentService/execution/executor';
import { PersistenceProjector } from '@/services/AgentService/outputs/persistence';
import { log } from '@/services/ObservabilityService';

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

/** A progress write scoped to the projector's current attempt (matches the writer path). */
function persistProgress(
    projector: PersistenceProjector,
    parts: Parameters<PersistenceProjector['persistOutputProgress']>[0]
) {
    return projector.persistOutputProgress(parts, {
        attemptGeneration: projector.getAttemptGeneration(),
        step: 0,
    });
}

describe('given a session with streamed reasoning and answer parts', () => {
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

    function readCheckpointJson(): string {
        return database.prepare('SELECT checkpoint_json FROM session_turn_attempts').get()!
            .checkpoint_json as string;
    }

    function readTurn() {
        return database.prepare('SELECT status, response_message_id FROM session_turns').get();
    }

    it('user recovers ordered output without a temporary attempt payload when streaming finishes', async () => {
        const projector = createProjector();
        const checkpoint = createCheckpoint();
        await projector.recordTurnStart(checkpoint);
        const savedCheckpoint = readCheckpointJson();
        provider.stream.mockImplementation(async function* () {
            yield { content: '', reasoning: 'Plan', done: false };
            yield { content: '', reasoningState: 'end', done: false };
            yield { content: 'Answer', done: true };
        });

        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: checkpoint,
            persister: projector,
        });

        expect(result).toMatchObject({
            type: 'completed',
            finalStepOutputParts: [
                { type: 'reasoning', content: 'Plan' },
                { type: 'text', content: 'Answer' },
            ],
        });
        expect(readCheckpointJson()).toBe(savedCheckpoint);
        const messages = await findMessagesBySessionId(1);
        expect(messages).toHaveLength(2);
        expect(messages[1]!.parts).toMatchObject([
            { type: 'reasoning', content: 'Plan' },
            { type: 'text', content: 'Answer' },
        ]);
    });

    it.each(['failed', 'cancelled'] as const)(
        'user retains the assistant link and reasoning boundaries when the turn is %s before the first delta',
        async (status) => {
            const projector = createProjector();
            await projector.recordTurnStart(createCheckpoint());
            const start = { type: 'reasoning' as const, content: '', startedAt: 1000 };
            await persistProgress(projector, [start]);
            const closed = [{ ...start, endedAt: 1500 }];

            if (status === 'failed') {
                await projector.markFailed('offline', closed);
            } else {
                await projector.markCancelled(closed);
            }

            const messages = await findMessagesBySessionId(1);
            expect(messages).toHaveLength(2);
            expect(messages[1]!.parts).toMatchObject([
                { type: 'reasoning', content: '', started_at: 1000, ended_at: 1500 },
            ]);
            expect(readTurn()).toEqual({ status, response_message_id: messages[1]!.id });
        }
    );

    it('user retains stable output parts when a boundary repeats and sees later content changes', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        await persistProgress(projector, [{ type: 'text', content: 'Partial answer' }]);
        const saved = (await findMessagesBySessionId(1))[1]!;

        await persistProgress(projector, [{ type: 'text', content: 'Partial answer' }]);
        expect((await findMessagesBySessionId(1))[1]!.parts).toEqual(saved.parts);

        await persistProgress(projector, [{ type: 'text', content: 'Partial answer v2' }]);
        const updated = await findMessagesBySessionId(1);
        expect(updated).toHaveLength(2);
        expect(updated[1]).toMatchObject({
            id: saved.id,
            parts: [{ type: 'text', content: 'Partial answer v2' }],
        });
    });

    it('user recovers ordered parts without a temporary snapshot when a tool-call step is saved', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const savedCheckpoint = readCheckpointJson();

        const messageId = await projector.persistToolCallMessage([
            { type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 2000 },
            { type: 'text', content: 'Checking' },
        ]);

        expect(readCheckpointJson()).toBe(savedCheckpoint);
        const messages = await findMessagesBySessionId(1);
        expect(messages).toHaveLength(2);
        expect(messages[1]).toMatchObject({
            id: messageId,
            role: 'tool_call',
            parts: [
                { type: 'reasoning', content: 'Plan', started_at: 1000, ended_at: 2000 },
                { type: 'text', content: 'Checking', started_at: null, ended_at: null },
            ],
        });
    });

    it.each(['failed', 'cancelled'] as const)(
        'user recovers partial ordered output when the turn is %s with final parts',
        async (status) => {
            const projector = createProjector();
            await projector.recordTurnStart(createCheckpoint());
            const savedCheckpoint = readCheckpointJson();
            const parts = [
                { type: 'reasoning' as const, content: 'Plan', startedAt: 1000, endedAt: 2000 },
                { type: 'text' as const, content: 'Partial answer' },
            ];

            if (status === 'failed') {
                await projector.markFailed('Offline', parts);
            } else {
                await projector.markCancelled(parts);
            }

            const messages = await findMessagesBySessionId(1);
            expect(messages).toHaveLength(2);
            expect(messages[1]!.parts).toMatchObject([
                { type: 'reasoning', content: 'Plan', started_at: 1000, ended_at: 2000 },
                { type: 'text', content: 'Partial answer', started_at: null, ended_at: null },
            ]);
            expect(readTurn()).toEqual({ status, response_message_id: messages[1]!.id });
            expect(readCheckpointJson()).toBe(savedCheckpoint);
        }
    );

    it.each(['failed', 'cancelled'] as const)(
        'user keeps durable output when the turn is %s without final parts',
        async (status) => {
            const projector = createProjector();
            await projector.recordTurnStart(createCheckpoint());
            await persistProgress(projector, [
                { type: 'reasoning', content: 'Saved thought', startedAt: 1000, endedAt: 2000 },
                { type: 'text', content: 'Saved answer' },
            ]);
            const saved = (await findMessagesBySessionId(1))[1]!;

            if (status === 'failed') {
                await projector.markFailed('Unexpected runtime error');
            } else {
                await projector.markCancelled();
            }

            const messages = await findMessagesBySessionId(1);
            expect(messages).toHaveLength(2);
            expect(messages[1]!.parts).toEqual(saved.parts);
            expect(readTurn()).toEqual({ status, response_message_id: saved.id });
        }
    );

    it('user recovers wall-clock reasoning boundaries when the turn completes', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.markCompleted({
            durationMs: 6000,
            outputParts: [
                { type: 'reasoning', content: 'Thought', startedAt: 1000, endedAt: 6500 },
                { type: 'text', content: 'Answer' },
            ],
        });

        const messages = await findMessagesBySessionId(1);
        expect(messages).toHaveLength(2);
        expect(messages[1]!.parts).toMatchObject([
            { type: 'reasoning', content: 'Thought', started_at: 1000, ended_at: 6500 },
            { type: 'text', content: 'Answer', started_at: null, ended_at: null },
        ]);
    });

    it('user sees one assistant message when a streamed turn completes', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const thought = {
            type: 'reasoning' as const,
            content: 'Plan',
            startedAt: 1000,
            endedAt: 2000,
        };
        await persistProgress(projector, [thought]);
        const saved = (await findMessagesBySessionId(1))[1]!;

        await projector.markCompleted({
            durationMs: 5000,
            outputParts: [thought, { type: 'text', content: 'Answer' }],
        });

        const messages = await findMessagesBySessionId(1);
        expect(messages).toHaveLength(2);
        expect(messages[1]).toMatchObject({
            id: saved.id,
            role: 'assistant',
            parts: [
                { type: 'reasoning', content: 'Plan' },
                { type: 'text', content: 'Answer' },
            ],
        });
        expect(readTurn()).toEqual({ status: 'completed', response_message_id: saved.id });
    });

    it('user keeps streamed output when completion brings no final parts', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        await persistProgress(projector, [
            { type: 'reasoning', content: 'Saved thought', startedAt: 1000, endedAt: 2000 },
        ]);
        const saved = (await findMessagesBySessionId(1))[1]!;

        await projector.markCompleted({ durationMs: 5000, outputParts: [] });

        const messages = await findMessagesBySessionId(1);
        expect(messages).toHaveLength(2);
        expect(messages[1]!.parts).toEqual(saved.parts);
        expect(readTurn()).toEqual({ status: 'completed', response_message_id: saved.id });
    });

    it('user sees a separate final reply when the streaming message becomes a tool-call step', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const parts = [
            { type: 'reasoning' as const, content: 'Plan', startedAt: 1000, endedAt: 2000 },
        ];
        await persistProgress(projector, parts);
        const saved = (await findMessagesBySessionId(1))[1]!;

        expect(await projector.persistToolCallMessage(parts)).toBe(saved.id);
        await projector.markCompleted({
            durationMs: 5000,
            outputParts: [{ type: 'text', content: 'Answer' }],
        });

        const messages = await findMessagesBySessionId(1);
        expect(messages).toMatchObject([
            { role: 'user' },
            { id: saved.id, role: 'tool_call', parts: [{ type: 'reasoning', content: 'Plan' }] },
            { role: 'assistant', parts: [{ type: 'text', content: 'Answer' }] },
        ]);
        expect(readTurn()).toEqual({ status: 'completed', response_message_id: messages[2]!.id });
    });

    it('user recovers a tool result in its owning part when the result is saved', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const call = await createToolPart('builtin', {
            session_id: 1,
            tool_call_id: 'call-1',
            tool_id: 'test-tool',
            input: '{}',
        });

        await projector.persistToolResult({
            result: 'done',
            toolCallPartId: call.id,
            toolCallMessageId: call.message_id,
        });

        expect(await findToolPartById('builtin', call.id)).toMatchObject({ output: 'done' });
        expect((await findMessagesBySessionId(1))[1]!.parts).toMatchObject([
            { id: call.id, type: 'tool_call', content: '' },
        ]);
    });

    it('user recovers tool-result attachments with their owning call when the result is saved', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const call = await createToolPart('mcp', {
            session_id: 1,
            tool_call_id: 'call-1',
            server_id: 1,
            tool_name: 'test-tool',
            input: '{}',
        });
        const attachment = await createAttachmentRecord({
            hash: 'hash-7',
            type: 'file',
            original_name: 'seven.txt',
            origin_path: 'D:/origin/seven.txt',
        });

        await projector.persistToolResult({
            result: 'file ready',
            toolCallPartId: call.id,
            toolCallMessageId: call.message_id,
            attachments: [
                {
                    id: 'attachment-1',
                    attachmentId: attachment.id,
                    hash: attachment.hash,
                    type: 'file',
                    path: 'D:/cache/seven.txt',
                    originPath: 'D:/origin/seven.txt',
                    name: 'seven.txt',
                },
            ],
        });

        const messages = await findMessagesBySessionId(1);
        expect(messages).toHaveLength(2);
        expect(messages[0]!.attachments).toEqual([]);
        expect(messages[1]!.attachments).toMatchObject([
            {
                id: attachment.id,
                message_id: call.message_id,
                origin_path: 'D:/origin/seven.txt',
                tool_call_id: 'call-1',
                tool_kind: 'mcp',
            },
        ]);
        expect(await findToolPartById('mcp', call.id)).toMatchObject({ output: 'file ready' });
    });

    it('user recovers the result on the correct message when a part id is missing and call ids repeat', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const callData = {
            session_id: 1,
            tool_call_id: 'call-77',
            tool_id: 'test-tool',
            input: '{}',
        };
        const earlier = await createToolPart('builtin', callData);
        const current = await createToolPart('builtin', callData);

        await projector.persistToolResult({
            result: 'recovered output',
            toolCallId: 'call-77',
            toolCallPartId: null,
            toolCallMessageId: current.message_id,
        });

        expect(await findToolPartById('builtin', earlier.id)).toMatchObject({ output: null });
        expect(await findToolPartById('builtin', current.id)).toMatchObject({
            output: 'recovered output',
        });
        expect((await findMessagesBySessionId(1))[2]!.parts).toMatchObject([
            { id: current.id, type: 'tool_call', content: '' },
        ]);
    });

    it('user keeps earlier tool results unchanged when the result has no owning message', async () => {
        vi.spyOn(log, 'error').mockImplementation(() => undefined);
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        await createToolPart('builtin', {
            session_id: 1,
            tool_call_id: 'call-77',
            tool_id: 'test-tool',
            input: '{}',
            output: 'earlier output',
        });
        const saved = await findMessagesBySessionId(1);

        await projector.persistToolResult({
            result: 'no message to attach to',
            toolCallId: 'call-77',
            toolCallPartId: null,
            toolCallMessageId: null,
        });

        expect(await findMessagesBySessionId(1)).toEqual(saved);
    });

    it.each(['unmatched output', ''])(
        'user sees no extra assistant text when the unmatched tool result is %j',
        async (result) => {
            vi.spyOn(log, 'error').mockImplementation(() => undefined);
            const projector = createProjector();
            await projector.recordTurnStart(createCheckpoint());
            const messageId = await projector.persistToolCallMessage([]);
            const saved = await findMessagesBySessionId(1);

            await projector.persistToolResult({
                result,
                toolCallId: 'call-missing',
                toolCallPartId: null,
                toolCallMessageId: messageId,
            });

            expect(await findMessagesBySessionId(1)).toEqual(saved);
        }
    );

    it('user retains the transcript when a safe boundary updates only checkpoint metadata', async () => {
        const projector = createProjector();
        const checkpoint = createCheckpoint();
        await projector.recordTurnStart(checkpoint);
        const saved = await findMessagesBySessionId(1);
        checkpoint.iteration = 2;
        checkpoint.response = 'Answer';
        checkpoint.reasoning = 'Plan';
        checkpoint.outputParts = [
            { type: 'reasoning', content: 'Plan' },
            { type: 'text', content: 'Answer' },
        ];

        await projector.persistCheckpoint(checkpoint);

        expect(JSON.parse(readCheckpointJson())).toEqual({
            activeModelId: 1,
            iteration: 2,
            modelSwitchCount: 0,
            modelLanguageContext: { locale: 'zh-CN', label: 'Simplified Chinese' },
            executedBuiltInToolIds: [],
            outputBoundary: { textLength: 6, reasoningLength: 4, partCount: 2 },
        });
        expect(await findMessagesBySessionId(1)).toEqual(saved);
    });

    it('user recovers reasoning provider options when the completed message is reloaded', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        const providerOptions = {
            openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc' },
        };

        await projector.markCompleted({
            durationMs: 5000,
            outputParts: [
                {
                    type: 'reasoning',
                    content: 'Thought',
                    startedAt: 1000,
                    endedAt: 6500,
                    providerOptions,
                },
                { type: 'text', content: 'Answer' },
            ],
        });

        const messages = await findMessagesBySessionId(1);
        expect(messages).toHaveLength(2);
        expect(messages[1]!.parts).toMatchObject([
            { type: 'reasoning', content: 'Thought' },
            { type: 'text', content: 'Answer' },
        ]);
        expect(JSON.parse(messages[1]!.parts[0]!.data)).toEqual(providerOptions);
    });
});
