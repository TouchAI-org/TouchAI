import { routeQueriesTo } from '@tests/database/sqliteHarness';
import {
    createAgentWindowFixture,
    network,
    response,
    toolResponse,
} from '@tests/utils/agentWindow';
import { getTauriInvokeCalls } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it } from 'vitest';

import { selectToolCalls } from '@/app/api/agent/history';
import { loadSessionTransportMessages } from '@/app/workflows/agent/historyTransport';
import { MAX_AUDIT_PAYLOAD_BYTES, serializeAuditPayload } from '@/platform/diagnostics/redact';

let fixture: ReturnType<typeof createAgentWindowFixture>;
beforeEach(() => {
    fixture = createAgentWindowFixture();
    fixture.database.exec(`INSERT INTO sessions (id, session_id, title, model, provider_id)
        VALUES (7, 'rejected-calls', 'Rejected calls', 'fixture-model', 1);
        INSERT INTO mcp_servers (id, name, transport_type, enabled)
        VALUES (7, 'Unavailable server', 'stdio', 0);`);
});

async function run(calls: { id: string; name: string; arguments: string }[], signal?: AbortSignal) {
    network.replies.push(toolResponse(calls), response('The rejected call did not run.'));
    const task = await fixture.window.api.startTask({
        sessionId: 7,
        prompt: 'Continue safely.',
        signal,
    });
    return task.completion;
}

describe('given the production model requests a tool that cannot be executed', () => {
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
        async (call) => {
            try {
                expect((await run([{ id: 'call-1', ...call }])).response).toBe(
                    'The rejected call did not run.'
                );
                expect(
                    getTauriInvokeCalls().filter(({ cmd }) =>
                        [
                            'mcp_call_tool',
                            'built_in_tools_execute_bash',
                            'built_in_tools_start_bash',
                        ].includes(cmd)
                    )
                ).toEqual([]);
                const restored = await loadSessionTransportMessages({ sessionId: 7 });
                const restoredCall = restored.find((message) => message.tool_calls?.length)!;
                expect(restoredCall.tool_calls).toEqual([{ id: 'call-1', ...call }]);
                expect(restoredCall.contextSource).toMatchObject({
                    id: expect.any(Number),
                    fingerprint: expect.any(String),
                });
                expect(restored.find((message) => message.role === 'tool')).toMatchObject({
                    name: call.name,
                    tool_call_id: 'call-1',
                    isError: true,
                    content: expect.any(String),
                });
                expect(network.requests[1]?.messages).not.toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({ contextSource: expect.anything() }),
                    ])
                );
                const { history } = await fixture.window.api.loadSession(7);
                if (call.name !== 'builtin__show_widget')
                    expect(history.flatMap(selectToolCalls)).toContainEqual(
                        expect.objectContaining({ namespacedName: call.name, status: 'error' })
                    );
                expect(history.flatMap((message) => message.widgets ?? [])).toEqual([]);
            } finally {
                await fixture.window.dispose();
            }
        }
    );

    it('user receives several rejected calls in one round and restores every complete exchange', async () => {
        const calls = [
            { id: 'opaque', name: 'ghost', arguments: '{}' },
            { id: 'malformed', name: 'builtin__bash', arguments: '{broken' },
            { id: 'unavailable', name: 'mcp__7__missing', arguments: '{}' },
        ];
        try {
            await run(calls);
            const restored = await loadSessionTransportMessages({ sessionId: 7 });
            expect(restored.find((message) => message.tool_calls?.length)?.tool_calls).toEqual(
                calls
            );
            expect(restored.filter((message) => message.role === 'tool')).toEqual(
                expect.arrayContaining(
                    calls.map((call) =>
                        expect.objectContaining({
                            name: call.name,
                            tool_call_id: call.id,
                            isError: true,
                        })
                    )
                )
            );
        } finally {
            await fixture.window.dispose();
        }
    });

    it('user reuses a call identity in a later turn and keeps each rejected result with its own call', async () => {
        try {
            await run([{ id: 'repeated', name: 'first_missing', arguments: '{}' }]);
            await run([{ id: 'repeated', name: 'second_missing', arguments: '[]' }]);
            expect(
                (await loadSessionTransportMessages({ sessionId: 7 })).filter(
                    (message) => message.role === 'tool'
                )
            ).toMatchObject([
                { name: 'first_missing', content: expect.stringContaining('first_missing') },
                { name: 'second_missing', content: expect.stringContaining('second_missing') },
            ]);
        } finally {
            await fixture.window.dispose();
        }
    });

    it('user receives rejected-call errors without saving secrets or unbounded arguments in the transcript', async () => {
        const args = '{"accessToken":"secret-value", "text":"' + 'x'.repeat(150_000);
        try {
            await run([{ id: 'call-1', name: 'ghost', arguments: args }]);
            const restored = await loadSessionTransportMessages({ sessionId: 7 });
            const input = restored.find((message) => message.tool_calls?.length)!.tool_calls![0]!
                .arguments;
            expect(input).toBe(serializeAuditPayload(args));
            expect(input).not.toContain('secret-value');
            expect(new TextEncoder().encode(input).length).toBeLessThanOrEqual(
                MAX_AUDIT_PAYLOAD_BYTES
            );
            expect(JSON.stringify(await fixture.window.api.loadSession(7))).not.toContain(
                'secret-value'
            );
        } finally {
            await fixture.window.dispose();
        }
    });

    it('user stops before another request when the rejected-call transaction fails and can retry after storage recovers', async () => {
        routeQueriesTo(fixture.database, {
            beforeCommit() {
                if (
                    fixture.database
                        .prepare("SELECT 1 FROM message_parts WHERE type = 'tool_call'")
                        .get()
                ) {
                    throw new Error('fixture rejected-call commit refusal');
                }
            },
        });
        try {
            await expect(
                run([{ id: 'call-1', name: 'ghost', arguments: '{}' }])
            ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
            expect(network.requests).toHaveLength(1);
            expect(
                fixture.database
                    .prepare("SELECT * FROM message_parts WHERE type = 'tool_call'")
                    .all()
            ).toEqual([]);
            routeQueriesTo(fixture.database);
            network.replies.length = 0;
            await run([{ id: 'call-2', name: 'ghost', arguments: '{}' }]);
            expect(
                (await loadSessionTransportMessages({ sessionId: 7 })).filter(
                    (message) => message.role === 'tool'
                )
            ).toMatchObject([{ tool_call_id: 'call-2', name: 'ghost', isError: true }]);
        } finally {
            await fixture.window.dispose();
        }
    });

    it('user cancels as the rejected-call barrier commits and keeps the error without starting another model request', async () => {
        const cancellation = new AbortController();
        routeQueriesTo(fixture.database, {
            beforeCommit() {
                if (
                    fixture.database
                        .prepare("SELECT 1 FROM message_parts WHERE type = 'tool_call'")
                        .get()
                )
                    cancellation.abort();
            },
        });
        try {
            await expect(
                run([{ id: 'call-1', name: 'ghost', arguments: '{}' }], cancellation.signal)
            ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
            expect(network.requests).toHaveLength(1);
            expect(
                (await loadSessionTransportMessages({ sessionId: 7 })).find(
                    (message) => message.role === 'tool'
                )
            ).toMatchObject({ name: 'ghost', isError: true });
        } finally {
            await fixture.window.dispose();
        }
    });
});
