// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { DatabaseSync } from 'node:sqlite';

import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTaskPersistence } from '@/app/workflows/agent/persistence';
import type { PersistenceCheckpoint } from '@/modules/agent';
import type { AttachmentReference, PersistenceCall } from '@/modules/agent/contracts';

let database: DatabaseSync;
beforeEach(() => {
    database = openMigratedDatabase();
    routeQueriesTo(database);
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'Fixture', 'openai', 'https://fixture.invalid', 'openai');
        INSERT INTO models (id, provider_id, name, model_id) VALUES (1, 1, 'Fixture', 'test-model');
        INSERT INTO sessions (id, session_id, title, model, provider_id)
        VALUES (1, 'fixture-session', 'Fixture', 'previous-model', 1);
    `);
});
afterEach(closeTestDatabases);

function createProjector(
    options: {
        newSession?: boolean;
        attachments?: AttachmentReference[];
        pendingMessageId?: string;
    } = {}
) {
    return createTaskPersistence({
        sessionId: options.newSession ? undefined : 1,
        model: { id: 1, provider_id: 1, model_id: 'test-model' },
        taskId: 'task-1',
        executionMode: 'foreground',
        prompt: 'hello',
        maxRetries: 3,
        buildSessionTitle: (prompt) => prompt,
        attachments: options.attachments,
        pendingMessageId: options.pendingMessageId,
        promptSnapshot: {
            id: 'prompt-1',
            createdAt: '2026-10-08T00:00:00Z',
            systemPrompt: '',
            executionMode: 'foreground',
            fragments: [],
            userPrompt: 'hello',
            attachments: [],
            modelLanguageContext: { locale: 'en-US', label: 'English' },
        },
    });
}

function checkpoint(): PersistenceCheckpoint {
    return {
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
}

function call(options: Partial<PersistenceCall> = {}): PersistenceCall {
    return {
        iteration: 0,
        modelId: 1,
        modelName: 'test-model',
        providerId: 1,
        providerName: 'Fixture',
        usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 1,
            cacheWriteTokens: 2,
            reasoningTokens: 3,
        },
        timing: { ttftMs: 100, durationMs: 500 },
        finishReason: 'stop',
        toolCallsInStep: 0,
        toolArgumentErrors: 0,
        ...options,
    };
}

function turn() {
    return database.prepare('SELECT * FROM session_turns ORDER BY id').get()!;
}
function attempts() {
    return database.prepare('SELECT * FROM session_turn_attempts ORDER BY attempt_index').all();
}
function messages() {
    return database.prepare('SELECT * FROM messages ORDER BY id').all();
}
function parts(type: string) {
    return database.prepare('SELECT * FROM message_parts WHERE type = ? ORDER BY id').all(type);
}
function progress(projector: ReturnType<typeof createProjector>, content: string) {
    return projector.persistOutputProgress([{ type: 'text', content }], {
        attemptGeneration: projector.getAttemptGeneration(),
        step: 0,
    });
}
function rejectWrite(table: string, condition = '1') {
    database.exec(`CREATE TEMP TRIGGER reject_write BEFORE UPDATE ON ${table}
        WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END;`);
}

describe('user waits for the answer while its turn is recorded', () => {
    it('user sees the prompt cost breakdown saved with the turn', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        expect(JSON.parse(turn().prompt_breakdown_json as string)).toEqual({
            fragments: {},
            userPrompt: 5,
            attachments: 0,
            builtinToolDefinitions: 0,
            mcpToolDefinitions: 0,
            systemPromptTotal: 0,
        });
    });

    it('user still gets the turn recorded when the optional cost breakdown cannot be built', async () => {
        database.exec('DROP TABLE mcp_tools');
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        expect(turn()).toMatchObject({ status: 'streaming', prompt_breakdown_json: null });
    });

    it('user sees the conversation created lazily when none was open', async () => {
        const projector = createProjector({ newSession: true });
        await projector.recordTurnStart(checkpoint());
        expect(
            database
                .prepare('SELECT model, provider_id FROM sessions WHERE id = ?')
                .get(projector.getSessionId()!)
        ).toEqual({ model: 'test-model', provider_id: 1 });
        expect(turn().session_id).toBe(projector.getSessionId());
    });

    it('user sees the open conversation model corrected to the model that answered', async () => {
        await createProjector().recordTurnStart(checkpoint());
        expect(
            database.prepare('SELECT model, provider_id FROM sessions WHERE id = 1').get()
        ).toEqual({ model: 'test-model', provider_id: 1 });
    });

    it('user receives a failed start instead of success when the conversation identity cannot be saved', async () => {
        rejectWrite('sessions');
        const projector = createProjector();
        await expect(projector.recordTurnStart(checkpoint())).rejects.toThrow();
        expect(messages()).toEqual([]);
        expect(projector.getTurn()).toBeNull();
        database.exec('DROP TRIGGER reject_write');
        await projector.recordTurnStart(checkpoint());
        expect(turn().status).toBe('streaming');
    });

    it('user sees the turn linked to the message they typed', async () => {
        await createProjector().recordTurnStart(checkpoint());
        expect(messages()).toMatchObject([{ id: turn().prompt_message_id, role: 'user' }]);
        expect(parts('text')).toMatchObject([
            { message_id: turn().prompt_message_id, content: 'hello' },
        ]);
    });

    it('user sees the turn start again without duplicating their message', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        const saved = messages();
        await projector.recordTurnStart(checkpoint());
        expect(messages()).toEqual(saved);
        expect(attempts()).toHaveLength(1);
        expect(projector.getAttemptGeneration()).toBe(1);
    });
});

describe('user sees usage counted once the answer is done', () => {
    it('user sees each model call stored against the reply that used it', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.markCompleted({
            durationMs: 900,
            outputParts: [{ type: 'text', content: 'Answer' }],
            calls: [call()],
        });
        expect(parts('llm_call')).toMatchObject([{ message_id: turn().response_message_id }]);
        expect(JSON.parse(parts('llm_call')[0]!.data as string)).toMatchObject({
            turnId: turn().id,
            iteration: 0,
            modelName: 'test-model',
            usage: call().usage,
            timing: call().timing,
        });
    });

    it('user sees the call count and tool activity saved with the turn', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.markCompleted({
            durationMs: 900,
            outputParts: [{ type: 'text', content: 'Answer' }],
            calls: [call({ toolCallsInStep: 2 })],
            toolArgumentErrors: 1,
            modelSwitchCount: 2,
            hitModelSwitchCeiling: true,
        });
        expect(turn()).toMatchObject({
            llm_call_count: 1,
            tool_call_count: 2,
            tool_argument_error_count: 1,
            model_switch_count: 2,
            hit_iteration_ceiling: 1,
            input_tokens: 10,
            output_tokens: 20,
        });
    });

    it('user sees the first answer delay saved when it was measured', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.markCompleted({
            durationMs: 900,
            outputParts: [],
            calls: [call()],
            ttftMs: 120,
            firstTextMs: 180,
        });
        expect(attempts()[0]).toMatchObject({ ttft_ms: 120 });
        expect(turn()).toMatchObject({ ttft_ms: 120, first_text_ms: 180 });
    });

    it('user sees a missing first-answer delay left empty rather than guessed', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.markCompleted({ durationMs: 900, outputParts: [], calls: [call()] });
        expect(attempts()[0]).toMatchObject({ ttft_ms: null });
        expect(turn()).toMatchObject({ ttft_ms: null, first_text_ms: null });
    });

    it('user sees no per-call rows when the answer recorded no calls', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.markCompleted({ durationMs: 900, outputParts: [] });
        expect(parts('llm_call')).toEqual([]);
        expect(turn()).toMatchObject({ llm_call_count: 0 });
    });

    it('user sees the reply reused when it was already streamed to the panel', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await progress(projector, 'Streamed');
        const replyId = turn().response_message_id;
        await projector.markCompleted({
            durationMs: 900,
            outputParts: [{ type: 'text', content: 'Final' }],
        });
        expect(messages()).toHaveLength(2);
        expect(parts('text')).toMatchObject([
            { content: 'hello' },
            { message_id: replyId, content: 'Final' },
        ]);
    });

    it('user sees the reply id kept when the turn closes with no further output', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.markCompleted({
            durationMs: 900,
            outputParts: [{ type: 'text', content: 'Answer' }],
        });
        const replyId = turn().response_message_id;
        await projector.markCompleted({ durationMs: 950, outputParts: [] });
        expect(turn().response_message_id).toBe(replyId);
        expect(messages()).toHaveLength(2);
    });

    it('user sees the failure reported when the completion cannot be saved', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        rejectWrite('session_turns', "NEW.status = 'completed'");
        await expect(
            projector.markCompleted({
                durationMs: 900,
                outputParts: [{ type: 'text', content: 'Answer' }],
            })
        ).rejects.toThrow();
        expect(messages()).toHaveLength(1);
        expect(turn().status).toBe('streaming');
    });
});

describe('user sees a failed turn recorded with its usage', () => {
    it('user sees the error code and retry scope saved with the failure', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.markFailed('offline', [], {
            calls: [call()],
            errorCode: 'NETWORK_ERROR',
            retryScope: 'checkpoint',
        });
        expect(turn()).toMatchObject({
            status: 'failed',
            error_code: 'NETWORK_ERROR',
            retry_scope: 'checkpoint',
        });
    });

    it('user sees the failure cleared of error metadata on a plain failure', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.markFailed('offline', [], { calls: [call()] });
        expect(turn()).toMatchObject({ status: 'failed', error_code: null, retry_scope: null });
    });

    it('user sees the failure reported when it cannot be saved', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        rejectWrite('session_turn_attempts');
        await expect(projector.markFailed('offline')).rejects.toThrow();
        expect(turn().status).toBe('streaming');
    });
});

describe('user cancels a turn that is being recorded', () => {
    it('user sees the turn recorded as cancelled by them', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.markCancelled([{ type: 'text', content: 'Half' }], {
            calls: [call()],
            errorCode: 'REQUEST_CANCELLED',
        });
        expect(turn()).toMatchObject({ status: 'cancelled', error_message: 'Cancelled by user' });
        expect(parts('text')).toMatchObject([{ content: 'hello' }, { content: 'Half' }]);
    });

    it('user sees the cancellation reported when it cannot be saved', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        rejectWrite('session_turn_attempts');
        await expect(projector.markCancelled()).rejects.toThrow();
        expect(turn().status).toBe('streaming');
    });
});

describe('user waits through a retry of the same turn', () => {
    it('user sees the failed attempt keep the tokens it already burned', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.beginNextAttempt('offline', checkpoint(), { calls: [call()], ttftMs: 90 });
        expect(attempts()).toMatchObject([
            { status: 'failed', input_tokens: 10, ttft_ms: 90 },
            { status: 'streaming' },
        ]);
    });

    it('user sees the failed attempt recorded without a delay it never measured', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.beginNextAttempt('offline', checkpoint(), { calls: [call()] });
        expect(attempts()[0]).toMatchObject({ input_tokens: 10, ttft_ms: null });
    });

    it('user sees the next attempt numbered after the one that failed', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.beginNextAttempt('offline', checkpoint());
        expect(attempts()).toMatchObject([
            { attempt_index: 1 },
            { attempt_index: 2, max_retries: 3 },
        ]);
    });

    it('user sees the turn put back to running after the retry starts', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.markFailed('offline');
        await projector.beginNextAttempt('offline', checkpoint());
        expect(turn()).toMatchObject({ status: 'streaming', error_message: null });
    });

    it('user sees the turn usage refreshed to include the failed attempt', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.beginNextAttempt('offline', checkpoint(), {
            calls: [call()],
            modelSwitchCount: 1,
            toolArgumentErrors: 2,
            hitModelSwitchCeiling: true,
        });
        expect(turn()).toMatchObject({
            input_tokens: 10,
            output_tokens: 20,
            llm_call_count: 1,
            model_switch_count: 1,
            tool_argument_error_count: 2,
            hit_iteration_ceiling: 1,
        });
    });

    it('user sees the retry refused before the turn was ever recorded', async () => {
        await expect(createProjector().beginNextAttempt('offline', checkpoint())).rejects.toThrow();
        expect(attempts()).toEqual([]);
    });

    it('user sees the retry reported when it cannot be saved', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        database.exec(`CREATE TEMP TRIGGER reject_retry BEFORE INSERT ON session_turn_attempts
            WHEN NEW.attempt_index > 1 BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END;`);
        await expect(projector.beginNextAttempt('offline', checkpoint())).rejects.toThrow();
        expect(attempts()).toMatchObject([{ attempt_index: 1, status: 'streaming' }]);
    });
});

describe('user sends attachments with the prompt and through tools', () => {
    function storedAttachment(): AttachmentReference {
        database.exec(`INSERT INTO attachments (id, hash, type, original_name, origin_path, mime_type, size)
            VALUES (7, 'hash-7', 'file', 'seven.txt', 'D:/origin/seven.txt', 'text/plain', 5);`);
        return {
            id: 'attachment-1',
            attachmentId: 7,
            hash: 'hash-7',
            type: 'file',
            path: 'D:/cache/seven.txt',
            originPath: 'D:/origin/seven.txt',
            name: 'seven.txt',
            mimeType: 'text/plain',
            size: 5,
        };
    }

    it('user sees the attachment they sent linked to their message', async () => {
        const projector = createProjector({ attachments: [storedAttachment()] });
        await projector.recordTurnStart(checkpoint());
        expect(parts('attachment')).toMatchObject([{ message_id: turn().prompt_message_id }]);
        expect(JSON.parse(parts('attachment')[0]!.data as string)).toEqual({
            attachmentId: 7,
            originPath: 'D:/origin/seven.txt',
        });
    });

    it('user sees an attachment that was already saved linked without being saved twice', async () => {
        const projector = createProjector({ attachments: [storedAttachment()] });
        await projector.recordTurnStart(checkpoint());
        expect(database.prepare('SELECT id FROM attachments').all()).toEqual([{ id: 7 }]);
        expect(parts('attachment')).toHaveLength(1);
        expect(JSON.parse(parts('attachment')[0]!.data as string).attachmentId).toBe(7);
    });

    it('user sees the delivery record kept up to date as attachments are planned', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        const request = {
            requestIndex: 0,
            providerDriver: 'openai',
            providerId: 1,
            modelId: 'test-model',
            createdAt: '2026-10-08T00:00:00Z',
            entries: [],
        };
        await projector.syncDeliveryManifestRequest(JSON.stringify(request));
        expect(JSON.parse(attempts()[0]!.delivery_manifest_json as string)).toEqual({
            version: 1,
            requests: [request],
        });
    });

    it('user sees no delivery record written before the turn exists', async () => {
        const projector = createProjector();
        await projector.syncDeliveryManifestRequest(
            JSON.stringify({
                requestIndex: 0,
                providerDriver: 'openai',
                providerId: 1,
                modelId: 'test-model',
                createdAt: '2026-10-08T00:00:00Z',
                entries: [],
            })
        );
        expect(attempts()).toEqual([]);
    });
});

describe('user reopens a turn whose bookkeeping was interrupted', () => {
    it('user sees progress saved before the turn record exists skipped quietly', async () => {
        await progress(createProjector(), 'typing');
        expect(messages()).toEqual([]);
    });

    it('user sees empty progress ignored instead of writing an empty reply', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.persistOutputProgress([], {
            attemptGeneration: projector.getAttemptGeneration(),
            step: 0,
        });
        expect(messages()).toHaveLength(1);
    });

    it('user sees the checkpoint saved without a turn record skipped quietly', async () => {
        await createProjector().persistCheckpoint(checkpoint());
        expect(attempts()).toEqual([]);
    });

    it('user sees the committed turn kept and a save failure when its terminal status is refused', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        rejectWrite('session_turns');
        await expect(
            projector.markCompleted({
                durationMs: 100,
                outputParts: [{ type: 'text', content: 'Answer' }],
            })
        ).rejects.toThrow();
        expect(projector.getTurn()?.status).toBe('streaming');
        expect(messages()).toHaveLength(1);
    });

    it('user sees no premature turn created when progress arrives before the start', async () => {
        const projector = createProjector();
        await progress(projector, 'typing');
        expect(projector.getTurn()).toBeNull();
        expect(database.prepare('SELECT id FROM session_turns').all()).toEqual([]);
    });

    it('user sees a cancelled turn keep the reply that already streamed', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await progress(projector, 'Half an answer');
        const replyId = turn().response_message_id;
        await projector.markCancelled();
        expect(turn()).toMatchObject({ status: 'cancelled', response_message_id: replyId });
        expect(messages()).toHaveLength(2);
        expect(parts('text')).toMatchObject([{ content: 'hello' }, { content: 'Half an answer' }]);
    });

    it('user sees usage saved without a turn id when no turn row exists yet', async () => {
        const projector = createProjector();
        await projector.markCompleted({
            durationMs: 100,
            outputParts: [{ type: 'text', content: 'Answer' }],
            calls: [call()],
        });
        expect(JSON.parse(parts('llm_call')[0]!.data as string)).toMatchObject({ turnId: null });
        expect(parts('llm_call')[0]!.message_id).toBe(turn().response_message_id);
    });

    it('user sees progress with no visible content ignored', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await progress(projector, '');
        expect(messages()).toHaveLength(1);
    });

    it('user sees a thinking fragment without a start time saved as unknown timing', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await projector.markCompleted({
            durationMs: 100,
            outputParts: [{ type: 'reasoning', content: 'Thought' }],
        });
        expect(parts('reasoning')).toMatchObject([
            { content: 'Thought', started_at: null, ended_at: null },
        ]);
    });

    it('user sees one conversation created when two writes race at the start', async () => {
        const projector = createProjector({ newSession: true });
        await Promise.all([
            projector.recordTurnStart(checkpoint()),
            projector.recordTurnStart(checkpoint()),
        ]);
        expect(database.prepare('SELECT id FROM sessions').all()).toHaveLength(2);
        expect(messages()).toHaveLength(1);
        expect(attempts()).toHaveLength(1);
    });
});

describe('user delivers a durable queued message', () => {
    function pending(id: string) {
        database
            .prepare(
                `INSERT INTO session_pending_messages
            (id, session_id, prompt, payload_version, payload_json, position)
            VALUES (?, 1, 'queued prompt', 1, '{"attachments":[]}', 0)`
            )
            .run(id);
    }
    function pendingIds() {
        return database.prepare('SELECT id FROM session_pending_messages').all();
    }

    it('user starts a queued turn when history commits then its pending row disappears atomically', async () => {
        pending('pending-1');
        const projector = createProjector({ pendingMessageId: 'pending-1' });
        database.exec(`CREATE TEMP TRIGGER refuse_pending_delete BEFORE DELETE ON session_pending_messages
            BEGIN SELECT RAISE(ABORT, 'fixture pending delete failure'); END;`);
        await expect(projector.recordTurnStart(checkpoint())).rejects.toThrow();
        expect(messages()).toEqual([]);
        expect(attempts()).toEqual([]);
        expect(pendingIds()).toEqual([{ id: 'pending-1' }]);
        database.exec('DROP TRIGGER refuse_pending_delete');
        await projector.recordTurnStart(checkpoint());
        expect(messages()).toHaveLength(1);
        expect(pendingIds()).toEqual([]);
    });

    it('user delivers a steer when its pending deletion fails then history and input metadata roll back together', async () => {
        pending('pending-2');
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        database.exec(`CREATE TEMP TRIGGER refuse_pending_delete BEFORE DELETE ON session_pending_messages
            BEGIN SELECT RAISE(ABORT, 'fixture pending delete failure'); END;`);
        const inserted = [
            {
                id: 'pending-2',
                prompt: 'Steer this',
                attachments: [],
                inputSnapshot: {
                    text: 'Steer this',
                    attachments: [],
                    skills: [{ name: 'skill', path: '/skill/SKILL.md' }],
                    editorDoc: { type: 'doc', content: [] },
                    excludeFromHistory: true,
                },
            },
        ];
        await expect(projector.persistInjectedUserMessages(inserted)).rejects.toThrow();
        expect(messages()).toHaveLength(1);
        expect(pendingIds()).toEqual([{ id: 'pending-2' }]);
        expect(
            JSON.parse(turn().prompt_snapshot_json as string).messageInputSnapshots
        ).toBeUndefined();
        database.exec('DROP TRIGGER refuse_pending_delete');
        const sources = await projector.persistInjectedUserMessages(inserted);
        expect(sources?.has('pending-2')).toBe(true);
        expect(messages()).toHaveLength(2);
        expect(pendingIds()).toEqual([]);
        expect(
            Object.values(JSON.parse(turn().prompt_snapshot_json as string).messageInputSnapshots)
        ).toEqual([
            {
                skills: [{ name: 'skill', path: '/skill/SKILL.md' }],
                editorDoc: { type: 'doc', content: [] },
                excludeFromHistory: true,
            },
        ]);
    });

    it('user interrupts an answer when delivery fails then later output preserves the interrupted row', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(checkpoint());
        await progress(projector, 'Interrupted answer');
        await projector.persistAssistantMessage([{ type: 'text', content: 'Interrupted answer' }]);
        projector.closeOutputBoundary();
        database.exec(`CREATE TEMP TRIGGER refuse_user BEFORE INSERT ON messages WHEN NEW.role = 'user'
            BEGIN SELECT RAISE(ABORT, 'fixture insertion failure'); END;`);
        await expect(
            projector.persistInjectedUserMessages([
                { id: 'pending', prompt: 'steer', attachments: [] },
            ])
        ).rejects.toThrow();
        await projector.markFailed('storage failed', []);
        expect(parts('text').map((part) => part.content)).toEqual(['hello', 'Interrupted answer']);
    });
});
