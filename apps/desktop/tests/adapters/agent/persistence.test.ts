import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { createAgent } from '@touchai/agent-core';
import type {
    AgentCheckpoint,
    AgentHost,
    AgentModel,
    AgentScope,
} from '@touchai/agent-core/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentMessageAdapter } from '@/adapters/agent/messages';
import {
    type CorePersistenceOptions,
    createCorePersistenceAdapter,
} from '@/adapters/agent/persistence';
import { createTaskPersistence } from '@/app/workflows/agent/persistence';

afterEach(closeTestDatabases);

const model: AgentModel = {
    key: 'fixture-model-key',
    connectionKey: 'fixture-connection-key',
    model: 'fixture-model',
    contextLimit: 8192,
    outputLimit: 1024,
    supportsReasoning: false,
    supportsTools: false,
};

function fixture() {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    database.exec(`INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'Fixture', 'openai', 'https://fixture.invalid', 'openai');
        INSERT INTO models (id, provider_id, name, model_id) VALUES (1, 1, 'Fixture', 'fixture-model');
        INSERT INTO sessions (id, session_id, title, model, provider_id)
        VALUES (1, 'fixture-session', 'Fixture', 'fixture-model', 1);`);
    const messages = createAgentMessageAdapter();
    const projector = createTaskPersistence({
        sessionId: 1,
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
    const options: CorePersistenceOptions = {
        persistence: projector,
        messages,
        modelIdentity: (key) => {
            if (key !== model.key) throw new Error('MODEL_BINDING_NOT_FOUND');
            return { id: 1, providerId: 1, providerName: 'Fixture', modelId: 'fixture-model' };
        },
        languageContext: { locale: 'en-US', label: 'English' },
        toolReceipt: () => undefined,
    };
    const persistence = createCorePersistenceAdapter(options);
    const host: AgentHost = {
        prepareTurn: async () => ({
            model,
            tools: {
                declarations: [],
                execute: async () => {
                    throw new Error('unexpected effect');
                },
            },
            messages: [{ role: 'user', content: 'authorized request' }],
            stream: async function* () {
                yield { content: 'final answer', done: true, finishReason: 'stop' };
            },
            release: () => messages.dispose(),
        }),
        persistence: () => persistence,
    };
    return { database, persistence, host, options };
}

describe('given Core executes through the shipped Desktop persistence boundary', () => {
    it('user receives completion only after the answer and terminal status are committed together', async () => {
        const { database, host } = fixture();
        const agent = createAgent(host);
        try {
            const task = agent.start({
                prompt: 'authorized request',
                conversationKey: 'fixture-conversation',
            });
            expect((await task.completion).response).toBe('final answer');
            expect(
                database
                    .prepare(
                        `SELECT t.status, p.content FROM session_turns t
                JOIN message_parts p ON p.message_id = t.response_message_id WHERE p.type = 'text'`
                    )
                    .get()
            ).toEqual({ status: 'completed', content: 'final answer' });
            const checkpoint = database
                .prepare('SELECT checkpoint_json FROM session_turn_attempts')
                .get()?.checkpoint_json;
            expect(JSON.parse(String(checkpoint))).toMatchObject({
                activeModelId: 1,
                iteration: 0,
                modelSwitchCount: 0,
                executedBuiltInToolIds: [],
            });
            expect(String(checkpoint)).not.toContain('fixture-model-key');
            expect(String(checkpoint)).not.toContain('authorized request');
        } finally {
            await agent.dispose();
        }
    });

    it('user receives a failed-save outcome rather than completion when SQLite rejects the terminal barrier', async () => {
        const { database, host } = fixture();
        database.exec(`CREATE TEMP TRIGGER reject_terminal BEFORE UPDATE ON session_turns
            WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture terminal failure'); END;`);
        const agent = createAgent(host);
        try {
            const task = agent.start({ prompt: 'authorized request' });
            await expect(task.completion).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
            expect(agent.getTask(task.taskId)?.status).toBe('failed');
            expect(database.prepare('SELECT status FROM session_turns').get()).toEqual({
                status: 'streaming',
            });
            expect(
                database.prepare('SELECT count(*) AS count FROM session_turn_attempts').get()
            ).toEqual({ count: 1 });
        } finally {
            await agent.dispose();
        }
    });

    it('user keeps the original persistence model and language after a caller replaces adapter options', async () => {
        const { database, host, options } = fixture();
        options.modelIdentity = () => ({
            id: 2,
            providerId: 2,
            providerName: 'Replacement',
            modelId: 'replacement',
        });
        options.languageContext.label = 'Replacement language';
        options.legacyExecutedToolIds = () => ['bash'];
        const agent = createAgent(host);
        try {
            expect((await agent.start({ prompt: 'authorized request' }).completion).response).toBe(
                'final answer'
            );
            const checkpoint = JSON.parse(
                String(
                    database.prepare('SELECT checkpoint_json FROM session_turn_attempts').get()
                        ?.checkpoint_json
                )
            );
            expect(checkpoint).toMatchObject({
                activeModelId: 1,
                executedBuiltInToolIds: [],
                modelLanguageContext: { locale: 'en-US', label: 'English' },
            });
        } finally {
            await agent.dispose();
        }
    });

    it('user admits tool audit only after its matching message barrier and rejects stale or terminal identities', async () => {
        const { persistence, database } = fixture();
        const scope: AgentScope = {
            taskId: 'fixture-task',
            attemptToken: 'first-attempt',
            attemptGeneration: 1,
            iteration: 0,
            signal: new AbortController().signal,
        };
        const checkpoint: AgentCheckpoint = {
            modelKey: model.key,
            messages: [{ role: 'user', content: 'request' }],
            response: '',
            reasoning: '',
            iteration: 0,
            modelSwitchCount: 0,
            outputParts: [],
        };
        const admission = {
            taskId: scope.taskId,
            attemptToken: scope.attemptToken,
            attemptGeneration: scope.attemptGeneration,
            sessionId: 1,
            messageId: 1,
        };
        expect(persistence.isToolAuditCurrent(admission)).toBe(false);
        await persistence.start(checkpoint, scope);
        expect(persistence.isToolAuditCurrent(admission)).toBe(false);
        const messageKey = await persistence.toolCalls(
            {
                parts: [],
                calls: [],
                call: {
                    iteration: 0,
                    modelKey: model.key,
                    connectionKey: model.connectionKey,
                    model: model.model,
                    usage: {
                        inputTokens: 0,
                        outputTokens: 0,
                        reasoningTokens: 0,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                    },
                    usageReported: false,
                    timing: { durationMs: 0 },
                    toolCallsInStep: 0,
                    toolArgumentErrors: 0,
                },
            },
            scope
        );
        const messageId = Number(
            database.prepare(`SELECT id FROM messages WHERE role = 'tool_call'`).get()?.id
        );
        const current = { ...admission, messageId };
        expect(persistence.isToolAuditCurrent(current)).toBe(true);
        for (const changed of [
            { taskId: 'other' },
            { attemptToken: 'stale' },
            { attemptGeneration: 2 },
            { sessionId: 2 },
            { messageId: messageId + 1 },
        ]) {
            expect(persistence.isToolAuditCurrent({ ...current, ...changed })).toBe(false);
        }
        await persistence.checkpoint(checkpoint, scope);
        expect(persistence.isToolAuditCurrent(current)).toBe(false);
        await persistence.finish(
            {
                status: 'completed',
                outputParts: [],
                calls: [],
                usage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    reasoningTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                },
                durationMs: 1,
                modelSwitchCount: 0,
                toolArgumentErrors: 0,
                hitModelSwitchCeiling: false,
            },
            scope
        );
        expect(persistence.isToolAuditCurrent(current)).toBe(false);
        expect(messageKey).not.toBe('');
    });
});
