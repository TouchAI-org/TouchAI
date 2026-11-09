import type { DatabaseSync } from 'node:sqlite';

import { findMessagesBySessionId } from '@database/queries/messages';
import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { getTauriInvokeCalls } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiRequestOptions } from '@/services/AgentService/contracts/protocol';
import type { AiToolCall } from '@/services/AgentService/contracts/tooling';
import { ContextWindow } from '@/services/AgentService/execution/context';
import {
    AiRequestExecutor,
    type AttemptCheckpoint,
} from '@/services/AgentService/execution/executor';
import { PersistenceProjector } from '@/services/AgentService/outputs/persistence';
import { loadSessionHistory } from '@/services/AgentService/session/history';
import { loadSessionTransportMessages } from '@/services/AgentService/session/transport';
import {
    MAX_AUDIT_PAYLOAD_BYTES,
    serializeAuditPayload,
} from '@/services/ObservabilityService/redact';
import { selectToolCalls } from '@/utils/session';

const provider = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@/services/AgentService/catalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/AgentService/catalog')>()),
    createProviderForModel: () => provider,
}));

function projector() {
    return new PersistenceProjector({
        sessionId: 1,
        model: { id: 1, provider_id: 1, model_id: 'test' },
        taskId: crypto.randomUUID(),
        executionMode: 'foreground',
        prompt: 'Continue safely.',
        maxRetries: 1,
        buildSessionTitle: (value) => value,
        promptSnapshot: {
            id: 'test',
            createdAt: '2026-11-09T00:00:00Z',
            systemPrompt: '',
            executionMode: 'foreground',
            fragments: [],
            userPrompt: 'Continue safely.',
            attachments: [],
            modelLanguageContext: { locale: 'en-US', label: 'English' },
        },
    });
}

function checkpoint(): AttemptCheckpoint {
    return new AiRequestExecutor().createInitialCheckpoint({
        initialModel: {
            id: 1,
            provider_id: 1,
            model_id: 'test',
            tool_call: 1,
            context_limit: null,
            output_limit: null,
        } as AttemptCheckpoint['activeModel'],
        baseMessages: [{ role: 'user', content: 'Continue safely.' }],
        modelLanguageContext: { locale: 'en-US', label: 'English' },
    });
}

describe('given a model requests a tool that cannot be executed', () => {
    let database: DatabaseSync;
    let sent: AiRequestOptions[];

    beforeEach(() => {
        provider.stream.mockReset();
        sent = [];
        database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO providers (id, name, driver, api_endpoint, logo)
            VALUES (1, 'Test', 'openai-compatible', 'https://example.invalid', '');
            INSERT INTO models (id, provider_id, name, model_id) VALUES (1, 1, 'Test', 'test');
            INSERT INTO sessions (id, session_id, title, model, provider_id)
            VALUES (1, 'rejected-calls', 'Rejected calls', 'test', 1);
            INSERT INTO mcp_servers (id, name, transport_type, enabled)
            VALUES (7, 'Unavailable server', 'stdio', 0);
        `);
    });
    afterEach(closeTestDatabases);

    function respondWith(toolCalls: AiToolCall[]) {
        provider.stream
            .mockImplementationOnce(async function* (request: AiRequestOptions) {
                sent.push(request);
                yield { content: '', done: true, finishReason: 'tool_calls', toolCalls };
            })
            .mockImplementationOnce(async function* (request: AiRequestOptions) {
                sent.push(request);
                yield { content: 'The rejected call did not run.', done: true };
            });
    }

    async function run(toolCalls: AiToolCall[], signal?: AbortSignal) {
        respondWith(toolCalls);
        const persister = projector();
        const startCheckpoint = checkpoint();
        await persister.recordTurnStart(startCheckpoint);
        return new AiRequestExecutor().runAttempt({ startCheckpoint, persister, signal });
    }

    it.each([
        { name: 'builtin__bash', arguments: '{broken' },
        { name: 'builtin__bash', arguments: '42' },
        { name: 'builtin__bash', arguments: 'false' },
        { name: 'builtin__bash', arguments: '"text"' },
        { name: 'builtin__bash', arguments: '[]' },
        { name: 'builtin__show_widget', arguments: 'null' },
        { name: 'builtin__missing', arguments: '{}' },
        { name: 'mcp__7__missing', arguments: '{}' },
        { name: 'mcp__999__missing', arguments: '{}' },
        { name: 'mcp__07__missing', arguments: '{}' },
        { name: 'mcp__9007199254740993__missing', arguments: '{}' },
        { name: 'ghost', arguments: '{}' },
    ])(
        'user reopens the rejected $name call with $arguments and retains its name, error and verifiable source',
        async ({ name, arguments: args }) => {
            const toolCall = { id: 'call-1', name, arguments: args };
            const result = await run([toolCall]);
            expect(result.type).toBe('completed');
            expect(
                getTauriInvokeCalls().filter((call) =>
                    [
                        'mcp_call_tool',
                        'built_in_tools_execute_bash',
                        'built_in_tools_start_bash',
                    ].includes(call.cmd)
                )
            ).toEqual([]);
            const liveCall = sent[1]!.messages.find((message) => message.tool_calls?.length);
            expect(liveCall?.contextSource?.id).toBeTypeOf('number');

            const restored = await loadSessionTransportMessages({ sessionId: 1 });
            const restoredCall = restored.find((message) => message.tool_calls?.length)!;
            expect(restoredCall.tool_calls).toEqual([toolCall]);
            expect(restoredCall.contextSource).toEqual(liveCall!.contextSource);
            const liveError = sent[1]!.messages.find((message) => message.role === 'tool')!;
            expect(restored.find((message) => message.role === 'tool')).toMatchObject({
                name,
                tool_call_id: toolCall.id,
                isError: true,
                content: liveError.content,
            });

            const history = await loadSessionHistory(1);
            const calls = history.flatMap(selectToolCalls);
            if (name !== 'builtin__show_widget')
                expect(calls).toContainEqual(
                    expect.objectContaining({ namespacedName: name, status: 'error' })
                );
            expect(history.flatMap((message) => message.legacyArtifacts ?? [])).toEqual([]);
        }
    );

    it('user receives several rejected calls in one round and restores every complete exchange', async () => {
        const calls = [
            { id: 'opaque', name: 'ghost', arguments: '{}' },
            { id: 'malformed', name: 'builtin__bash', arguments: '{broken' },
            { id: 'unavailable', name: 'mcp__7__missing', arguments: '{}' },
        ];
        expect((await run(calls)).type).toBe('completed');
        const live = sent[1]!.messages.find((message) => message.tool_calls?.length)!;
        expect(live.contextSource).toBeDefined();
        const restored = await loadSessionTransportMessages({ sessionId: 1 });
        const restoredCalls = restored.find((message) => message.tool_calls?.length)!.tool_calls!;
        expect(restoredCalls).toHaveLength(calls.length);
        expect(restoredCalls).toEqual(expect.arrayContaining(calls));
        expect(restored.filter((message) => message.role === 'tool')).toEqual(
            expect.arrayContaining(
                calls.map((call) =>
                    expect.objectContaining({
                        tool_call_id: call.id,
                        name: call.name,
                        isError: true,
                    })
                )
            )
        );
    });

    it('user compacts a rejected exchange and reopens its committed summary without regenerating it', async () => {
        expect((await run([{ id: 'call-1', name: 'ghost', arguments: '{}' }])).type).toBe(
            'completed'
        );
        for (let index = 0; index < 24; index++) {
            const message = database
                .prepare('INSERT INTO messages (session_id, role) VALUES (1, ?) RETURNING id')
                .get(index % 2 ? 'assistant' : 'user')!;
            database
                .prepare(
                    "INSERT INTO message_parts (message_id, type, content, sort_order) VALUES (?, 'text', ?, 0)"
                )
                .run(Number(message.id), 'Verified evidence. '.repeat(200));
        }
        const persister = projector();
        await persister.recordTurnStart(checkpoint());
        const summarized: AiRequestOptions[] = [];
        const prepared = await new ContextWindow().prepare({
            request: {
                model: 'test',
                messages: await loadSessionTransportMessages({ sessionId: 1 }),
            },
            contextLimit: 8000,
            outputLimit: 1000,
            summarize: async (request) => {
                summarized.push(request);
                return { text: 'The unavailable tool was rejected.', finishReason: 'stop' };
            },
            saveSummary: (summary, source) => persister.persistContextSummary(summary, [], source),
        });
        expect(
            summarized.flatMap((request) =>
                request.messages.flatMap((message) => message.tool_calls ?? [])
            )
        ).toContainEqual({ id: 'call-1', name: 'ghost', arguments: '{}' });
        expect(prepared.messages.some((message) => message.contextSummary)).toBe(true);
        const reopened = await loadSessionTransportMessages({ sessionId: 1 });
        expect(reopened).toEqual(prepared.messages);
        await new ContextWindow().prepare({
            request: { model: 'test', messages: reopened },
            contextLimit: 8000,
            outputLimit: 1000,
            summarize: async () => {
                throw new Error('A reusable summary must not be generated again');
            },
            saveSummary: async () => {
                throw new Error('A reusable summary must not be saved again');
            },
        });
        expect((await findMessagesBySessionId(1)).some((row) => row.role === 'tool_call')).toBe(
            true
        );
    });

    it('user reuses a call ID in a later message and keeps each rejected result with its own call', async () => {
        await run([{ id: 'repeated', name: 'first_missing', arguments: '{}' }]);
        await run([{ id: 'repeated', name: 'second_missing', arguments: '[]' }]);
        const restored = await loadSessionTransportMessages({ sessionId: 1 });
        expect(restored.filter((message) => message.role === 'tool')).toMatchObject([
            { name: 'first_missing', content: expect.stringContaining('first_missing') },
            { name: 'second_missing', content: expect.stringContaining('second_missing') },
        ]);
    });

    it('user receives rejected-call errors without persisting secrets or unbounded arguments', async () => {
        const args = '{"accessToken":"secret-value", "text":"' + 'x'.repeat(150_000);
        expect((await run([{ id: 'call-1', name: 'ghost', arguments: args }])).type).toBe(
            'completed'
        );
        const restored = await loadSessionTransportMessages({ sessionId: 1 });
        const input = restored.find((message) => message.tool_calls?.length)!.tool_calls![0]!
            .arguments;
        expect(input).toBe(serializeAuditPayload(args));
        expect(input).not.toContain('secret-value');
        expect(new TextEncoder().encode(input).length).toBeLessThanOrEqual(MAX_AUDIT_PAYLOAD_BYTES);
    });

    it('user encounters a rejected-call write failure and stops before another request with the partial write rolled back', async () => {
        routeQueriesTo(database, {
            beforeCommit: () => {
                if (database.prepare("SELECT 1 FROM message_parts WHERE type='tool_call'").get())
                    throw new Error('Simulated rejected-call commit failure');
            },
        });
        const result = await run([{ id: 'call-1', name: 'ghost', arguments: '{}' }]);
        expect(result.type).toBe('failed');
        expect(sent).toHaveLength(1);
        expect(
            database.prepare("SELECT * FROM message_parts WHERE type='tool_call'").all()
        ).toEqual([]);
        expect(
            (await loadSessionTransportMessages({ sessionId: 1 })).some(
                (message) => message.contextSummary
            )
        ).toBe(false);
        routeQueriesTo(database);
        provider.stream.mockReset();
        expect((await run([{ id: 'call-2', name: 'ghost', arguments: '{}' }])).type).toBe(
            'completed'
        );
        expect(
            (await loadSessionTransportMessages({ sessionId: 1 })).filter(
                (message) => message.role === 'tool'
            )
        ).toMatchObject([{ tool_call_id: 'call-2', name: 'ghost', isError: true }]);
    });

    it('user cancels while the rejected call commits and retains the error without starting another request', async () => {
        const controller = new AbortController();
        routeQueriesTo(database, {
            beforeCommit: () => {
                if (database.prepare("SELECT 1 FROM message_parts WHERE type='tool_call'").get())
                    controller.abort();
            },
        });
        const result = await run(
            [{ id: 'call-1', name: 'ghost', arguments: '{}' }],
            controller.signal
        );
        expect(result).toMatchObject({ type: 'failed', error: { code: 'REQUEST_CANCELLED' } });
        expect(sent).toHaveLength(1);
        expect(
            (await loadSessionTransportMessages({ sessionId: 1 })).find(
                (message) => message.role === 'tool'
            )
        ).toMatchObject({ name: 'ghost', isError: true });
    });
});
