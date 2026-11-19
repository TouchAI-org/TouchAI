import { emitTo, listen } from '@tauri-apps/api/event';
import { mockWindows } from '@tauri-apps/api/mocks';
import { createAgentWindowFixture, network, response } from '@tests/utils/agentWindow';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, it, vi } from 'vitest';

import { initializeAgentWindow } from '@/app/bootstrap/agent';
import { createStartupCapabilities } from '@/app/bootstrap/capabilities';

describe('given the agent entry used by production window startup', () => {
    it('user receives a durably saved answer through the configured provider and all shipped tool declarations', async () => {
        const input = createAgentWindowFixture();
        network.replies.push(response('production answer'));
        try {
            const started = await input.window.api.startTask({ prompt: 'production request' });
            expect((await started.completion).response).toBe('production answer');
            expect(input.database.prepare('SELECT status FROM session_turns').get()).toEqual({
                status: 'completed',
            });
            const request = network.requests[0]!;
            expect(request.model).toBe('fixture-model');
            expect(
                (request.tools as { function: { name: string } }[]).map(
                    (tool) => tool.function.name
                )
            ).toEqual(
                expect.arrayContaining([
                    'builtin__read',
                    'builtin__bash',
                    'builtin__web_search',
                    'builtin__web_fetch',
                    'builtin__ask_user_question',
                    'builtin__activate_skill',
                    'builtin__upgrade_model',
                    'builtin__show_widget',
                    'builtin__setting',
                    'builtin__file_search',
                ])
            );
            const snapshot = input.window.api.getTaskSnapshot(started.taskId)!;
            expect(snapshot.status).toBe('completed');
            expect(JSON.stringify(snapshot)).not.toMatch(
                /fixture-secret|checkpoint_json|prompt_snapshot_json/
            );
            expect(
                (await input.window.api.loadSession(snapshot.sessionId!)).history.at(-1)?.content
            ).toBe('production answer');
        } finally {
            await input.window.dispose();
        }
    });

    it('user answers the production question once and a stale or duplicate answer cannot change its next turn', async () => {
        const input = createAgentWindowFixture();
        network.replies.push(response('', true), response('Left selected'));
        try {
            const started = await input.window.api.startTask({
                prompt: 'production question request',
            });
            await expect
                .poll(
                    () =>
                        input.window.api.getTaskSnapshot(started.taskId)?.pendingUserQuestion
                            ?.decisionId
                )
                .toBeTruthy();
            const question = input.window.api.getTaskSnapshot(started.taskId)!.pendingUserQuestion!;
            const answer = [{ questionIndex: 0, selectedLabels: ['Left'], skipped: false }];
            expect(
                input.window.api.settleTaskUserQuestion(
                    started.taskId,
                    question.callId,
                    answer,
                    'stale'
                )
            ).toBe(false);
            expect(
                input.window.api.settleTaskUserQuestion(
                    started.taskId,
                    question.callId,
                    answer,
                    question.decisionId
                )
            ).toBe(true);
            expect(
                input.window.api.settleTaskUserQuestion(
                    started.taskId,
                    question.callId,
                    answer,
                    question.decisionId
                )
            ).toBe(false);
            expect((await started.completion).response).toBe('Left selected');
            expect(JSON.stringify(network.requests[1])).toContain('answered: Left');
        } finally {
            await input.window.dispose();
        }
    });

    it('user cancels while startup is pending without leaving a task that begins after readiness arrives', async () => {
        let ready!: () => void;
        const capabilities = createStartupCapabilities(() => undefined);
        capabilities.register(
            'model-metadata',
            new Promise<void>((resolve) => {
                ready = resolve;
            })
        );
        const input = createAgentWindowFixture('main', capabilities);
        const cancellation = new AbortController();
        try {
            const pending = input.window.api.startTask({
                prompt: 'cancel before readiness',
                signal: cancellation.signal,
            });
            cancellation.abort();
            await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
            ready();
            await input.window.ready;
            expect(input.window.api.listActiveTasks()).toEqual([]);
            expect(network.requests).toEqual([]);
            expect(
                input.database.prepare('SELECT count(*) AS count FROM session_turns').get()
            ).toEqual({ count: 0 });
        } finally {
            ready();
            await input.window.dispose();
        }
    });

    it('user can submit after an optional warm-up fails even when its diagnostic sink is unavailable', async () => {
        const capabilities = createStartupCapabilities(() => {
            throw new Error('fixture diagnostics unavailable');
        });
        capabilities.register(
            'model-metadata',
            Promise.reject(new Error('fixture metadata unavailable'))
        );
        const input = createAgentWindowFixture('main', capabilities);
        network.replies.push(response('ready despite optional failure'));
        try {
            const started = await input.window.api.startTask({ prompt: 'best effort startup' });
            expect((await started.completion).response).toBe('ready despite optional failure');
            expect(input.database.prepare('SELECT status FROM session_turns').get()).toEqual({
                status: 'completed',
            });
        } finally {
            await input.window.dispose();
        }
    });

    it('user receives an early task failure when awaiting it later and can submit a following request', async () => {
        const input = createAgentWindowFixture();
        input.database.exec('UPDATE models SET context_limit = 128');
        try {
            const failed = await input.window.api.startTask({
                prompt: 'request exceeds fixture capacity',
            });
            await expect
                .poll(() => input.window.api.getTaskSnapshot(failed.taskId)?.status)
                .toBe('failed');
            await expect(failed.completion).rejects.toMatchObject({ code: 'CONTEXT_TOO_LARGE' });
            expect(network.requests).toEqual([]);
            input.database.exec('UPDATE models SET context_limit = 262144');
            network.replies.push(response('following request succeeds'));
            const following = await input.window.api.startTask({ prompt: 'following request' });
            expect((await following.completion).response).toBe('following request succeeds');
        } finally {
            await input.window.dispose();
        }
    });

    it('user cancels a slow history load without starting a late task and can reuse that session', async () => {
        let pause = true;
        let paused = false;
        let resume!: () => void;
        const waiting = new Promise<void>((resolve) => {
            resume = resolve;
        });
        const input = createAgentWindowFixture('main', undefined, {
            beforeQuery: ({ sql }) => {
                if (pause && sql.startsWith('select') && sql.includes('from "sessions"')) {
                    paused = true;
                    return waiting;
                }
            },
        });
        input.database.exec(`INSERT INTO sessions (id, session_id, title, model, provider_id)
            VALUES (7, 'history-fixture', 'Previous request', 'fixture-model', 1);`);
        const cancellation = new AbortController();
        try {
            const pending = input.window.api.startTask({
                prompt: 'cancel during history',
                sessionId: 7,
                signal: cancellation.signal,
            });
            await expect.poll(() => paused).toBe(true);
            cancellation.abort();
            await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
            pause = false;
            resume();
            await Promise.resolve();
            expect(input.window.api.listActiveTasks()).toEqual([]);
            expect(network.requests).toEqual([]);
            expect(
                input.database.prepare('SELECT count(*) AS count FROM session_turns').get()
            ).toEqual({ count: 0 });
            network.replies.push(response('following history request'));
            const following = await input.window.api.startTask({
                prompt: 'use the same session',
                sessionId: 7,
            });
            expect((await following.completion).response).toBe('following history request');
        } finally {
            pause = false;
            resume();
            await input.window.dispose();
        }
    });

    it('user completes a request with the final model recorded as used without changing another model', async () => {
        const input = createAgentWindowFixture();
        network.replies.push(response('recorded model usage'));
        input.database.exec(`INSERT INTO models (id, provider_id, name, model_id)
            VALUES (2, 1, 'Other model', 'unused-model');`);
        try {
            const started = await input.window.api.startTask({ prompt: 'record this model only' });
            expect((await started.completion).response).toBe('recorded model usage');
            const used = input.database
                .prepare('SELECT last_used_at FROM models WHERE id = 1')
                .get();
            expect(used?.last_used_at).toEqual(expect.any(String));
            expect(
                input.database.prepare('SELECT last_used_at FROM models WHERE id = 2').get()
            ).toEqual({ last_used_at: null });
        } finally {
            await input.window.dispose();
        }
    });

    it('user retains a committed answer when its model bookkeeping write fails without replaying the request', async () => {
        const input = createAgentWindowFixture();
        network.replies.push(response('saved despite bookkeeping failure'));
        input.database
            .exec(`CREATE TEMP TRIGGER reject_model_touch BEFORE UPDATE OF last_used_at ON models
            BEGIN SELECT RAISE(ABORT, 'fixture model bookkeeping refusal'); END;`);
        try {
            const started = await input.window.api.startTask({
                prompt: 'finish with best effort bookkeeping',
            });
            expect((await started.completion).response).toBe('saved despite bookkeeping failure');
            expect(input.window.api.getTaskSnapshot(started.taskId)?.status).toBe('completed');
            expect(input.database.prepare('SELECT status FROM session_turns').get()).toEqual({
                status: 'completed',
            });
            expect(network.requests).toHaveLength(1);
        } finally {
            await input.window.dispose();
        }
    });

    it('user reopens MCP tool history with its configured server name and no new execution', async () => {
        const input = createAgentWindowFixture();
        input.database
            .exec(`INSERT INTO sessions (id, session_id, title, model) VALUES (7, 'mcp-history-fixture', 'Previous tool', 'fixture-model');
            INSERT INTO mcp_servers (id, name, transport_type, command) VALUES (4, 'Local documents', 'stdio', 'fixture');
            INSERT INTO messages (id, session_id, role) VALUES (8, 7, 'tool_call');`);
        input.database
            .prepare(
                `INSERT INTO message_parts (message_id, type, content, sort_order, data) VALUES (8, 'tool_call', '', 0, ?)`
            )
            .run(
                JSON.stringify({
                    toolCallId: 'previous-call',
                    toolKind: 'mcp',
                    server_id: 4,
                    tool_name: 'read_document',
                    input: '{}',
                    output: 'previous result',
                    status: 'success',
                })
            );
        try {
            const { history } = await input.window.api.loadSession(7);
            expect(
                history
                    .flatMap((message) => message.parts)
                    .find((part) => part.type === 'tool_call')
            ).toMatchObject({
                toolCall: { serverName: 'Local documents', result: 'previous result' },
            });
            expect(network.requests).toEqual([]);
        } finally {
            await input.window.dispose();
        }
    });

    it('user refreshes Provider metadata from settings through main without creating another execution owner', async () => {
        const main = createAgentWindowFixture();
        await main.window.ready;
        await main.window.capabilities.waitForAgent();
        const seeded = main.database.prepare('SELECT count(*) AS count FROM built_in_tools').get();
        mockWindows('settings');
        const settings = initializeAgentWindow();
        network.replies.push(
            Response.json({
                data: [{ id: 'discovered-model', name: 'Discovered', context_window: 4096 }],
            })
        );
        try {
            expect(await settings.models.listModels(1)).toEqual([
                {
                    id: 'discovered-model',
                    name: 'discovered-model',
                    capabilities: { contextLimit: 4096 },
                },
            ]);
            expect(network.discovery.map(({ url }) => url)).toEqual([
                'https://fixture.invalid/v1/models',
            ]);
            expect(network.discovery[0]?.headers.get('authorization')).toBe(
                'Bearer fixture-secret'
            );
            expect(
                main.database.prepare('SELECT count(*) AS count FROM built_in_tools').get()
            ).toEqual(seeded);
            await expect(
                settings.api.startTask({ prompt: 'not a main request' })
            ).rejects.toMatchObject({ code: 'MAIN_EXECUTION_HOST_REQUIRED' });
            expect(network.requests).toEqual([]);
        } finally {
            await settings.dispose();
            await main.window.dispose();
        }
    });

    it('user can inspect a disabled Provider from settings without authorizing it for Agent execution', async () => {
        const main = createAgentWindowFixture();
        await main.window.ready;
        main.database.exec('UPDATE providers SET enabled = 0 WHERE id = 1');
        network.replies.push(Response.json({ data: [{ id: 'disabled-profile-model' }] }));
        try {
            expect(await main.window.models.listModels(1)).toEqual([
                { id: 'disabled-profile-model', name: 'disabled-profile-model' },
            ]);
            const started = await main.window.api.startTask({
                prompt: 'disabled profile must not execute',
                providerId: 1,
                modelId: 'fixture-model',
            });
            await expect(started.completion).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
            expect(network.requests).toEqual([]);
        } finally {
            await main.window.dispose();
        }
    });

    it('user receives a bounded unavailable-host failure in settings rather than a local Provider fallback', async () => {
        vi.useFakeTimers();
        const settings = createAgentWindowFixture('settings');
        try {
            const pending = settings.window.models.listModels(1);
            const failure = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
            await vi.advanceTimersByTimeAsync(60_000);
            await failure;
            expect(network.discovery).toEqual([]);
            expect(
                settings.database.prepare('SELECT count(*) AS count FROM built_in_tools').get()
            ).toEqual({ count: 0 });
        } finally {
            await settings.window.dispose();
        }
    });

    it('user receives a discovery failure without exposing an upstream credential or error body to another window', async () => {
        const main = createAgentWindowFixture();
        await main.window.ready;
        mockWindows('settings');
        const settings = initializeAgentWindow();
        const otherWindow: unknown[] = [];
        const stop = await listen(
            'models:discovery:reply',
            ({ payload }) => otherWindow.push(payload),
            { target: { kind: 'Window', label: 'tray-menu' } }
        );
        network.replies.push(
            new Response('fixture-secret and private upstream error body', { status: 401 })
        );
        try {
            const error = await settings.models.listModels(1).catch((failure: unknown) => failure);
            expect(error).toMatchObject({ code: 'UNAUTHORIZED' });
            expect(JSON.stringify(error)).not.toMatch(/fixture-secret|private upstream error body/);
            expect(otherWindow).toEqual([]);
            network.replies.push(Response.json({ data: [{ id: 'following-model' }] }));
            expect(await settings.models.listModels(1)).toEqual([
                { id: 'following-model', name: 'following-model' },
            ]);
        } finally {
            stop();
            await settings.dispose();
            await main.window.dispose();
        }
    });

    it('user cancels a pending discovery and can refresh again without a retained connection or a late result', async () => {
        const main = createAgentWindowFixture();
        await main.window.ready;
        mockWindows('settings');
        const settings = initializeAgentWindow();
        const cancellation = new AbortController();
        network.respondToDiscovery = (signal) =>
            new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        try {
            const pending = settings.models.listModels(1, { signal: cancellation.signal });
            const failure = expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
            await expect.poll(() => network.discovery.length).toBe(1);
            cancellation.abort();
            await failure;
            await expect.poll(() => network.discovery[0]?.signal?.aborted).toBe(true);
            network.respondToDiscovery = undefined;
            network.replies.push(Response.json({ data: [{ id: 'after-cancel' }] }));
            expect(await settings.models.listModels(1)).toEqual([
                { id: 'after-cancel', name: 'after-cancel' },
            ]);
            expect(main.window.api.listActiveTasks()).toEqual([]);
            expect(network.requests).toEqual([]);
        } finally {
            await settings.dispose();
            await main.window.dispose();
        }
    });

    it('user cannot trigger model discovery through malformed configuration or a broadcast reply address', async () => {
        const main = createAgentWindowFixture();
        await main.window.ready;
        try {
            await emitTo('main', 'models:discovery:request', {
                kind: 'list',
                requestId: crypto.randomUUID(),
                replyTo: '*',
                providerId: 1,
            });
            await emitTo('main', 'models:discovery:request', {
                kind: 'list',
                requestId: crypto.randomUUID(),
                replyTo: 'settings',
                providerId: 1,
                apiKey: 'untrusted-profile-override',
            });
            await Promise.resolve();
            expect(network.discovery).toEqual([]);
            expect(main.window.api.listActiveTasks()).toEqual([]);
        } finally {
            await main.window.dispose();
        }
    });

    it('user connects an MCP server from settings and its next real Agent turn uses the same main-owned tool binding', async () => {
        const main = createAgentWindowFixture();
        await main.window.ready;
        main.database
            .exec(`INSERT INTO mcp_servers (id, name, transport_type, url, headers, enabled)
            VALUES (4, 'Documents', 'http', 'https://fixture.invalid/mcp', '{"Authorization":"fixture-mcp-secret"}', 1);
            INSERT INTO mcp_tools (server_id, name, input_schema, enabled)
            VALUES (4, 'disabled', '{"type":"object","properties":{}}', 0);`);
        mockTauriCommand('mcp_get_client_status', { server_id: 4, status: 'connected' });
        mockTauriCommand('mcp_list_tools', [
            { name: 'read_document', input_schema: { type: 'object', properties: {} } },
            { name: 'disabled', input_schema: { type: 'object', properties: {} } },
        ]);
        mockTauriCommand('mcp_call_tool', {
            success: true,
            is_error: false,
            content: [{ type: 'text', text: 'configured document' }],
        });
        mockWindows('settings');
        const settings = initializeAgentWindow();
        try {
            await settings.mcp.connectServer(4);
            expect(getTauriInvokeCalls('mcp_connect_server').map(({ payload }) => payload)).toEqual(
                [
                    {
                        config: expect.objectContaining({
                            id: 4,
                            headers: { Authorization: 'fixture-mcp-secret' },
                        }),
                        connectionOrigin: 'user',
                    },
                ]
            );
            network.replies.push(
                response('', false, { name: 'mcp__4__read_document', arguments: '{}' }),
                response('document answer')
            );
            const started = await main.window.api.startTask({
                prompt: 'read the configured document',
            });
            expect((await started.completion).response).toBe('document answer');
            expect(
                (network.requests[0]?.tools as { function: { name: string } }[]).map(
                    ({ function: tool }) => tool.name
                )
            ).toEqual(expect.arrayContaining(['mcp__4__read_document']));
            expect(JSON.stringify(network.requests[0])).not.toMatch(
                /mcp__4__disabled|fixture-mcp-secret/
            );
            expect(JSON.stringify(network.requests[1])).toContain('configured document');
            expect(getTauriInvokeCalls('mcp_call_tool').map(({ payload }) => payload)).toEqual([
                { serverId: 4, toolName: 'read_document', arguments: {}, timeoutMs: 30000 },
            ]);
            await settings.mcp.disconnectServer(4);
            network.replies.push(response('disconnected answer'));
            const following = await main.window.api.startTask({ prompt: 'after disconnect' });
            await following.completion;
            expect(JSON.stringify(network.requests[2]?.tools)).not.toContain(
                'mcp__4__read_document'
            );
        } finally {
            await settings.dispose();
            await main.window.dispose();
        }
    });

    it('user receives a bounded MCP connection failure without a secondary native connection or fallback tools owner', async () => {
        vi.useFakeTimers();
        const settings = createAgentWindowFixture('settings');
        try {
            const pending = settings.window.mcp.connectServer(4);
            const failure = expect(pending).rejects.toMatchObject({
                code: 'MCP_COMMAND_UNCONFIRMED',
                outcome: 'unknown',
            });
            await vi.advanceTimersByTimeAsync(15_000);
            await failure;
            expect(getTauriInvokeCalls('mcp_connect_server')).toEqual([]);
            expect(
                settings.database.prepare('SELECT count(*) AS count FROM built_in_tools').get()
            ).toEqual({ count: 0 });
            await expect(settings.window.autoConnectMcp()).rejects.toMatchObject({
                code: 'MAIN_EXECUTION_HOST_REQUIRED',
            });
        } finally {
            await settings.window.dispose();
        }
    });

    it('user refreshes model capabilities in settings through the main Models owner before the next real turn', async () => {
        const main = createAgentWindowFixture();
        await main.window.ready;
        mockWindows('settings');
        const settings = initializeAgentWindow();
        network.replies.push(
            Response.json({
                models: {
                    'fixture/model': {
                        id: 'fixture-model',
                        name: 'Fixture',
                        limit: { context: 32768, output: 1024 },
                        tool_call: true,
                    },
                },
                alias: { 'fixture-model': 'fixture/model' },
            })
        );
        try {
            expect(await settings.metadata.refresh({ force: true })).toEqual({ status: 'updated' });
            expect(network.discovery.map(({ url }) => url)).toEqual([
                'https://models.dev/api.json',
            ]);
            expect(
                main.database
                    .prepare('SELECT context_limit, output_limit FROM models WHERE id = 1')
                    .get()
            ).toEqual({ context_limit: 32768, output_limit: 1024 });
            expect(network.discovery[0]?.headers.get('authorization')).toBeNull();
            network.replies.push(response('answer after metadata refresh'));
            const task = await main.window.api.startTask({ prompt: 'use refreshed metadata' });
            expect((await task.completion).response).toBe('answer after metadata refresh');
            await expect(
                settings.api.startTask({ prompt: 'no secondary owner' })
            ).rejects.toMatchObject({ code: 'MAIN_EXECUTION_HOST_REQUIRED' });
        } finally {
            await settings.dispose();
            await main.window.dispose();
        }
    });

    it('user closes one metadata client without cancelling another caller sharing the main catalog request', async () => {
        const main = createAgentWindowFixture();
        await main.window.ready;
        mockWindows('settings');
        const settings = initializeAgentWindow();
        let reply!: (response: Response) => void;
        network.respondToDiscovery = () =>
            new Promise<Response>((resolve) => {
                reply = resolve;
            });
        try {
            const client = settings.metadata.refresh({ force: true });
            const cancelled = expect(client).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
            await expect.poll(() => network.discovery.length).toBe(1);
            const remaining = main.window.metadata.refresh({ force: true });
            await settings.dispose();
            await cancelled;
            reply(
                Response.json({
                    models: { 'fixture/model': { id: 'fixture-model', name: 'Fixture' } },
                    alias: { 'fixture-model': 'fixture/model' },
                })
            );
            expect(await remaining).toEqual({ status: 'updated' });
            expect(network.discovery).toHaveLength(1);
            expect(main.database.prepare('SELECT model_id FROM llm_metadata').all()).toEqual([
                { model_id: 'fixture/model' },
            ]);
        } finally {
            await settings.dispose();
            await main.window.dispose();
        }
    });

    it.each(['settings', 'tray-menu', 'computer-use-glow', 'unknown'])(
        'user cannot acquire fallback execution from the %s window by navigating to a main route',
        async (label) => {
            window.location.hash = '#/main';
            const input = createAgentWindowFixture(label);
            try {
                await expect(
                    input.window.api.startTask({ prompt: 'not a main request' })
                ).rejects.toMatchObject({ code: 'MAIN_EXECUTION_HOST_REQUIRED' });
                expect(network.requests).toEqual([]);
                expect(
                    input.database.prepare('SELECT count(*) AS count FROM built_in_tools').get()
                ).toEqual({ count: 0 });
                expect(
                    input.database.prepare('SELECT count(*) AS count FROM session_turns').get()
                ).toEqual({ count: 0 });
            } finally {
                await input.window.dispose();
            }
        }
    );

    it('user cannot start execution after the main window has released its lifetime', async () => {
        const input = createAgentWindowFixture();
        await input.window.dispose();
        await expect(input.window.api.startTask({ prompt: 'late request' })).rejects.toMatchObject({
            code: 'AGENT_DISPOSED',
        });
        expect(network.requests).toEqual([]);
    });
});
