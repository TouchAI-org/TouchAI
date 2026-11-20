import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import type { ToolEvent, ToolInvocationScope, ToolRegistration } from '@/modules/tools';
import { createToolAudit, createTools } from '@/modules/tools';

afterEach(closeTestDatabases);

function fixture() {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    database.exec(`INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'Fixture', 'openai', 'https://fixture.invalid', 'openai');
        INSERT INTO sessions (id, session_id, title, model, provider_id)
        VALUES (1, 'fixture-session', 'Fixture', 'fixture-model', 1);
        INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'tool_call');`);
    const events: ToolEvent[] = [];
    let attemptToken = 'attempt-one';
    const audit = createToolAudit({
        taskId: 'task-one',
        isCurrent: (scope) => scope.task?.attemptToken === attemptToken,
    });
    const scope: ToolInvocationScope = {
        iteration: 0,
        task: {
            taskId: 'task-one',
            attemptToken,
            attemptGeneration: 1,
            historyTarget: { sessionId: 1, messageId: 1 },
            signal: new AbortController().signal,
            stop: () => {},
            currentModel: {
                key: 'model-key',
                id: 1,
                provider_id: 1,
                provider_name: 'Fixture',
                model_id: 'fixture-model',
                name: 'Fixture',
                supportsImages: true,
            },
            ask: async () => null,
            present: (event) => events.push(event),
        },
    };
    return {
        database,
        events,
        audit,
        scope,
        changeAttempt: () => {
            attemptToken = 'attempt-two';
        },
    };
}

function write(): ToolRegistration {
    return {
        name: 'builtin__bash',
        source: 'builtin',
        prepare: async () => ({
            declaration: {
                name: 'builtin__bash',
                description: 'run',
                input_schema: { type: 'object', properties: {} },
            },
            authorize: async () => true,
            execute: async () => ({
                result: 'effect completed',
                isError: false,
                conversationSemantic: { action: 'run', target: 'fixture command' },
                structuredPayload: { kind: 'computer_use', action: 'inspect', route: 'fixture' },
            }),
        }),
    };
}

describe('given the controlled pipeline writes through the existing atomic SQLite tool writer', () => {
    it('user receives a committed redacted audit receipt without losing the tool presentation payload', async () => {
        const { database, events, audit, scope } = fixture();
        const tools = createTools({
            registrations: [write()],
            formatError: (code) => code,
            beginAudit: audit.begin,
        });
        try {
            const outcome = await (
                await tools.snapshot()
            ).execute(
                {
                    id: 'call',
                    name: 'builtin__bash',
                    arguments: '{"authorization":"Bearer fixture-secret-credential"}',
                },
                scope
            );
            const stored = JSON.parse(
                String(
                    database
                        .prepare("SELECT data FROM message_parts WHERE type = 'tool_call'")
                        .get()?.data
                )
            );
            expect(stored).toMatchObject({
                toolKind: 'builtin',
                toolCallId: 'call',
                tool_id: 'bash',
                status: 'success',
                input: '{"authorization":"[redacted]"}',
                output: 'effect completed',
                conversation_semantic_json: '{"action":"run","target":"fixture command"}',
                structured_payload_json:
                    '{"kind":"computer_use","action":"inspect","route":"fixture"}',
            });
            expect(
                audit.receipt(outcome.receiptKey, {
                    taskId: 'task-one',
                    attemptToken: 'attempt-one',
                })
            ).toMatchObject({ input: stored.input, partId: expect.any(Number) });
            expect(
                audit.receipt(outcome.receiptKey, {
                    taskId: 'task-other',
                    attemptToken: 'attempt-one',
                })
            ).toBeUndefined();
            expect(
                audit.receipt(outcome.receiptKey, {
                    taskId: 'task-one',
                    attemptToken: 'attempt-old',
                })
            ).toBeUndefined();
            expect(events.at(-1)).toMatchObject({
                type: 'call_end',
                finalStatus: 'completed',
                result: 'effect completed',
            });
            audit.commit();
            expect(
                audit.receipt(outcome.receiptKey, {
                    taskId: 'task-one',
                    attemptToken: 'attempt-one',
                })
            ).toBeUndefined();
        } finally {
            tools.dispose();
            audit.dispose();
        }
    });

    it('user cannot start a new effect when its initial audit write is rejected by SQLite', async () => {
        const { database, audit, scope } = fixture();
        database.exec(`CREATE TEMP TRIGGER reject_start BEFORE INSERT ON message_parts
            BEGIN SELECT RAISE(ABORT, 'fixture start failure'); END;`);
        const tools = createTools({
            registrations: [write()],
            formatError: (code) => code,
            beginAudit: audit.begin,
        });
        try {
            await expect(
                (await tools.snapshot()).execute(
                    { id: 'call', name: 'builtin__bash', arguments: '{}' },
                    scope
                )
            ).rejects.toMatchObject({ outcome: { isError: true, sideEffect: 'none' } });
            expect(database.prepare('SELECT count(*) AS count FROM message_parts').get()).toEqual({
                count: 0,
            });
        } finally {
            tools.dispose();
            audit.dispose();
        }
    });

    it('user cannot acknowledge a completed effect when its audit target disappears', async () => {
        const { database, audit, scope } = fixture();
        const descriptor = write();
        descriptor.prepare = async () => ({
            declaration: {
                name: 'builtin__bash',
                description: 'run',
                input_schema: { type: 'object', properties: {} },
            },
            authorize: async () => true,
            execute: async () => {
                database.exec("DELETE FROM message_parts WHERE type = 'tool_call'");
                return { result: 'effect completed', isError: false };
            },
        });
        const tools = createTools({
            registrations: [descriptor],
            formatError: (code) => code,
            beginAudit: audit.begin,
        });
        try {
            await expect(
                (await tools.snapshot()).execute(
                    { id: 'call', name: 'builtin__bash', arguments: '{}' },
                    scope
                )
            ).rejects.toMatchObject({ outcome: { isError: true, sideEffect: 'unknown' } });
        } finally {
            tools.dispose();
            audit.dispose();
        }
    });

    it('user cannot write stale or duplicate call audits into the current attempt', async () => {
        const { database, audit, scope, changeAttempt } = fixture();
        const call = { id: 'call', name: 'builtin__bash', arguments: '{}' };
        try {
            await audit.begin(call, {}, scope);
            await expect(audit.begin(call, {}, scope)).rejects.toThrow('TOOL_CALL_DUPLICATE');
            changeAttempt();
            await expect(audit.begin({ ...call, id: 'stale' }, {}, scope)).rejects.toThrow(
                'TOOL_SCOPE_STALE'
            );
            expect(database.prepare('SELECT count(*) AS count FROM message_parts').get()).toEqual({
                count: 1,
            });
            audit.dispose();
            await expect(audit.begin({ ...call, id: 'disposed' }, {}, scope)).rejects.toThrow(
                'TOOL_SCOPE_STALE'
            );
        } finally {
            audit.dispose();
        }
    });
});
