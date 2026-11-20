import { routeQueriesTo } from '@tests/database/sqliteHarness';
import {
    createAgentWindowFixture,
    network,
    response,
    responseFromDeltas,
    streamingResponse,
    toolResponse,
} from '@tests/utils/agentWindow';
import { emitTauriChannelMessage, getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TrackedEvent {
    eventName: string;
    operationId: string;
    attributes: Record<string, unknown>;
}

let fixture: ReturnType<typeof createAgentWindowFixture>;

function events(name: string): TrackedEvent[] {
    return getTauriInvokeCalls('analytics_track')
        .map((call) => (call.payload as { request: TrackedEvent }).request)
        .filter((event) => event.eventName === name);
}

async function terminal(): Promise<TrackedEvent> {
    await vi.waitFor(() => expect(events('agent.request_completed')).toHaveLength(1));
    return events('agent.request_completed')[0]!;
}

async function connectMcp(): Promise<void> {
    fixture.database.exec(`INSERT INTO mcp_servers (id, name, transport_type, url, enabled)
        VALUES (4, 'Documents', 'http', 'https://fixture.invalid/mcp', 1);`);
    mockTauriCommand('mcp_get_client_status', { server_id: 4, status: 'connected' });
    mockTauriCommand('mcp_list_tools', [
        { name: 'read_document', input_schema: { type: 'object', properties: {} } },
    ]);
    await fixture.window.mcp.connectServer(4);
}

beforeEach(async () => {
    mockTauriCommand('analytics_begin_operation', {
        operationId: 'fixture-operation',
        enabled: true,
        consentEpoch: 3,
    });
    mockTauriCommand('analytics_complete_operation', undefined);
    mockTauriCommand('analytics_track', { status: 'persisted', eventId: 'fixture-event' });
    fixture = createAgentWindowFixture();
    await fixture.window.ready;
    await fixture.window.capabilities.waitForAgent();
});

afterEach(async () => {
    await fixture.window.dispose();
    vi.restoreAllMocks();
});

describe('given typed analytics observes the real production main task', () => {
    it('user gets no first-output event for reasoning or unfinished tool arguments before body text arrives', async () => {
        vi.useFakeTimers();
        const channel = streamingResponse();
        network.replies.push(channel.response);
        const started = await fixture.window.api.startTask({ prompt: 'private request content' });
        await vi.advanceTimersByTimeAsync(0);
        channel.delta({ role: 'assistant', reasoning_content: 'hidden planning' });
        channel.delta({
            tool_calls: [
                {
                    index: 0,
                    id: 'unfinished-call',
                    type: 'function',
                    function: { name: 'builtin__bash', arguments: '{' },
                },
            ],
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(events('agent.first_output_received')).toEqual([]);
        channel.delta({ content: 'display-ready answer' });
        await vi.advanceTimersByTimeAsync(0);
        expect(events('agent.first_output_received')).toHaveLength(1);
        const cancelled = expect(started.completion).rejects.toMatchObject({
            code: 'REQUEST_CANCELLED',
        });
        fixture.window.api.cancelTask(started.taskId);
        await cancelled;
        channel.fail(new Error('late fixture failure'));
        await terminal();
        expect(events('agent.first_output_received')).toHaveLength(1);
        expect(JSON.stringify(getTauriInvokeCalls('analytics_track'))).not.toMatch(
            /private request content|hidden planning|display-ready answer|fixture-secret|unfinished-call/
        );
    });

    it('user cancels a live approval and retains one cancelled decision and tool at the approval phase', async () => {
        fixture.database.exec(
            `UPDATE built_in_tools SET config_json = '{"approvalMode":"always"}' WHERE tool_id = 'bash'`
        );
        network.replies.push(
            toolResponse([
                {
                    id: 'approval-call',
                    name: 'builtin__bash',
                    arguments: JSON.stringify({
                        command: 'Remove-Item fixture.txt',
                        reason: 'fixture approval',
                        workingDirectory: 'C:/fixture',
                    }),
                },
            ])
        );
        const started = await fixture.window.api.startTask({ prompt: 'cancel at the approval' });
        await expect
            .poll(() => fixture.window.api.getTaskSnapshot(started.taskId)?.pendingToolApproval)
            .toBeTruthy();
        const decision = fixture.window.api.getTaskSnapshot(started.taskId)!.pendingToolApproval!;
        const cancelled = expect(started.completion).rejects.toMatchObject({
            code: 'REQUEST_CANCELLED',
        });
        fixture.window.api.cancelTask(started.taskId);
        await cancelled;
        expect((await terminal()).attributes).toMatchObject({
            result: 'cancelled',
            cancel_stage: 'approval',
            tool_count: 1,
            approval_count: 1,
            persistence_result: 'saved',
        });
        expect(events('agent.approval_resolved')).toEqual([
            expect.objectContaining({
                attributes: expect.objectContaining({ resolution: 'cancelled' }),
            }),
        ]);
        expect(events('agent.tool_completed')).toEqual([
            expect.objectContaining({
                attributes: expect.objectContaining({
                    tool_category: 'command',
                    result: 'cancelled',
                }),
            }),
        ]);
        expect(
            fixture.window.api.approveTaskToolCall(
                started.taskId,
                decision.callId,
                decision.decisionId
            )
        ).toBe(false);
        expect(
            getTauriInvokeCalls().filter((call) =>
                ['built_in_tools_execute_bash', 'built_in_tools_start_bash'].includes(call.cmd)
            )
        ).toEqual([]);
        expect(network.requests).toHaveLength(1);
    });

    it('user rejects a live approval and gets a rejection rather than cancellation while the model can continue', async () => {
        fixture.database.exec(
            `UPDATE built_in_tools SET config_json = '{"approvalMode":"always"}' WHERE tool_id = 'bash'`
        );
        network.replies.push(
            toolResponse([
                {
                    id: 'rejected-call',
                    name: 'builtin__bash',
                    arguments: JSON.stringify({
                        command: 'Remove-Item fixture.txt',
                        reason: 'fixture approval',
                        workingDirectory: 'C:/fixture',
                    }),
                },
            ]),
            response('continued safely')
        );
        const started = await fixture.window.api.startTask({ prompt: 'reject the command' });
        await expect
            .poll(() => fixture.window.api.getTaskSnapshot(started.taskId)?.pendingToolApproval)
            .toBeTruthy();
        const decision = fixture.window.api.getTaskSnapshot(started.taskId)!.pendingToolApproval!;
        expect(
            fixture.window.api.rejectTaskToolCall(
                started.taskId,
                decision.callId,
                decision.decisionId
            )
        ).toBe(true);
        expect((await started.completion).response).toBe('continued safely');
        expect((await terminal()).attributes).toMatchObject({
            result: 'success',
            tool_count: 1,
            approval_count: 1,
        });
        expect(events('agent.approval_resolved')[0]?.attributes.resolution).toBe('rejected');
        expect(events('agent.tool_completed')[0]?.attributes.result).toBe('failure');
        expect(
            getTauriInvokeCalls().filter((call) =>
                ['built_in_tools_execute_bash', 'built_in_tools_start_bash'].includes(call.cmd)
            )
        ).toEqual([]);
    });

    it('user cancels a remote tool wait locally without losing its outcome or counting a late success twice', async () => {
        await connectMcp();
        let release!: (value: unknown) => void;
        mockTauriCommand(
            'mcp_call_tool',
            () =>
                new Promise((resolve) => {
                    release = resolve;
                })
        );
        network.replies.push(
            toolResponse([{ id: 'remote-call', name: 'mcp__4__read_document', arguments: '{}' }])
        );
        const started = await fixture.window.api.startTask({ prompt: 'cancel a remote wait' });
        await expect.poll(() => getTauriInvokeCalls('mcp_call_tool')).toHaveLength(1);
        const cancelled = expect(started.completion).rejects.toMatchObject({
            code: 'REQUEST_CANCELLED',
        });
        fixture.window.api.cancelTask(started.taskId);
        await cancelled;
        expect((await terminal()).attributes).toMatchObject({
            result: 'cancelled',
            cancel_stage: 'tool',
            tool_count: 1,
        });
        expect(events('agent.tool_completed')[0]?.attributes).toMatchObject({
            tool_category: 'mcp',
            result: 'cancelled',
        });
        release({
            success: true,
            is_error: false,
            content: [{ type: 'text', text: 'late private result' }],
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(events('agent.tool_completed')).toHaveLength(1);
        expect(events('agent.request_completed')).toHaveLength(1);
        expect(JSON.stringify(getTauriInvokeCalls('analytics_track'))).not.toMatch(
            /remote-call|read_document|late private result/
        );
        expect(network.requests).toHaveLength(1);
    });

    it('user receives a remote server error as a failed tool rather than a user cancellation', async () => {
        await connectMcp();
        mockTauriCommand('mcp_call_tool', {
            success: true,
            is_error: true,
            content: [{ type: 'text', text: 'server cancelled its own work' }],
        });
        network.replies.push(
            toolResponse([{ id: 'remote-error', name: 'mcp__4__read_document', arguments: '{}' }]),
            response('remote failure explained')
        );
        const started = await fixture.window.api.startTask({ prompt: 'handle the remote error' });
        expect((await started.completion).response).toBe('remote failure explained');
        expect((await terminal()).attributes).toMatchObject({ result: 'success', tool_count: 1 });
        expect(events('agent.tool_completed')[0]?.attributes).toMatchObject({
            tool_category: 'mcp',
            result: 'failure',
        });
    });

    it('user cancels the stream following a completed tool and records the streaming phase instead of the retired tool phase', async () => {
        await connectMcp();
        mockTauriCommand('mcp_call_tool', { success: true, is_error: false, content: [] });
        const channel = streamingResponse();
        network.replies.push(
            toolResponse([{ id: 'finished-tool', name: 'mcp__4__read_document', arguments: '{}' }]),
            channel.response
        );
        const started = await fixture.window.api.startTask({
            prompt: 'cancel the following stream',
        });
        await expect.poll(() => network.requests).toHaveLength(2);
        const cancelled = expect(started.completion).rejects.toMatchObject({
            code: 'REQUEST_CANCELLED',
        });
        fixture.window.api.cancelTask(started.taskId);
        await cancelled;
        channel.fail(new Error('late fixture failure'));
        expect((await terminal()).attributes).toMatchObject({
            result: 'cancelled',
            cancel_stage: 'streaming',
            tool_count: 1,
        });
        expect(events('agent.tool_completed')[0]?.attributes.result).toBe('success');
        expect(events('agent.first_output_received')).toEqual([]);
    });

    it('user retries a failed partial stream and includes both attempts once with honest partial usage and pricing', async () => {
        fixture.database
            .exec(`INSERT INTO llm_metadata (model_id, name, modalities, input_cost_per_million, output_cost_per_million)
            VALUES ('fixture-model', 'Fixture', '[]', '1', '1');`);
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const channel = streamingResponse();
        network.replies.push(channel.response, response('recovered answer'));
        const started = await fixture.window.api.startTask({
            prompt: 'retry the partial response',
        });
        await vi.advanceTimersByTimeAsync(0);
        channel.delta({ role: 'assistant', content: 'discarded partial answer' });
        await vi.advanceTimersByTimeAsync(0);
        channel.fail(new Error('network connection lost'));
        await vi.waitFor(() =>
            expect(fixture.window.api.getTaskSnapshot(started.taskId)?.status).toBe('completed')
        );
        expect((await started.completion).response).toBe('recovered answer');
        expect((await terminal()).attributes).toMatchObject({
            result: 'success',
            retry_count: 1,
            llm_call_count: 2,
            usage_coverage: 'partial',
            pricing_coverage: 'partial',
            unpriced_call_count: 1,
            total_tokens: 15,
            cost_usd_micros: 15,
        });
        expect(events('agent.request_submitted')).toHaveLength(1);
        expect(events('agent.first_output_received')).toHaveLength(1);
    });

    it('user approves a model upgrade and retries from its committed checkpoint without counting the switch twice', async () => {
        fixture.database
            .exec(`INSERT INTO models (id, provider_id, name, model_id, tool_call, context_limit, output_limit)
            VALUES (2, 1, 'Upgraded fixture', 'upgraded-fixture', 1, 262144, 1024);
            UPDATE built_in_tools SET config_json = '{"chain":[{"providerId":1,"modelId":"fixture-model"},{"providerId":1,"modelId":"upgraded-fixture"}]}'
            WHERE tool_id = 'upgrade_model';`);
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const upgradedResponse = Promise.withResolvers<Response>();
        network.respondToGeneration = async () => {
            if (network.requests.length === 1)
                return toolResponse([
                    { id: 'upgrade-call', name: 'builtin__upgrade_model', arguments: '{}' },
                ]);
            if (network.requests.length === 2) return upgradedResponse.promise;
            return response('answer after the upgraded request retries');
        };
        const started = await fixture.window.api.startTask({ prompt: 'upgrade and continue' });
        await vi.waitFor(() =>
            expect(
                fixture.window.api.getTaskSnapshot(started.taskId)?.pendingToolApproval
            ).toBeTruthy()
        );
        const decision = fixture.window.api.getTaskSnapshot(started.taskId)!.pendingToolApproval!;
        expect(
            fixture.window.api.approveTaskToolCall(
                started.taskId,
                decision.callId,
                decision.decisionId
            )
        ).toBe(true);
        // A late HTTP failure schedules backoff after this clock advance has finished.
        await vi.advanceTimersByTimeAsync(2000);
        upgradedResponse.resolve(
            Response.json({ error: { message: 'HTTP 503' } }, { status: 503 })
        );
        await vi.waitFor(() =>
            expect(fixture.window.api.getTaskSnapshot(started.taskId)?.status).toBe('completed')
        );
        expect(await started.completion).toMatchObject({
            response: 'answer after the upgraded request retries',
            model: { modelId: 'upgraded-fixture' },
        });
        expect(network.requests.map((request) => request.model)).toEqual([
            'fixture-model',
            'upgraded-fixture',
            'upgraded-fixture',
        ]);
        expect((await terminal()).attributes).toMatchObject({
            result: 'success',
            retry_count: 1,
            model_switch_count: 1,
            llm_call_count: 3,
            tool_count: 1,
            approval_count: 1,
        });
        expect(events('agent.tool_completed')).toHaveLength(1);
        expect(
            fixture.database.prepare('SELECT model_id FROM models WHERE is_default = 1').get()
        ).toEqual({
            model_id: 'fixture-model',
        });
    });

    it.each([
        [{}, 'unavailable', undefined, undefined],
        [{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, 'observed', 0, 0],
    ] as const)(
        'user finishes with %j usage and distinguishes %s evidence from fabricated zero',
        async (usage, coverage, tokens, cost) => {
            fixture.database
                .exec(`INSERT INTO llm_metadata (model_id, name, modalities, input_cost_per_million, output_cost_per_million)
            VALUES ('fixture-model', 'Fixture', '[]', '1', '1');`);
            network.replies.push(
                responseFromDeltas(
                    [{ role: 'assistant', content: 'answer with usage evidence' }],
                    'stop',
                    usage
                )
            );
            const started = await fixture.window.api.startTask({ prompt: 'honest usage coverage' });
            await started.completion;
            const attributes = (await terminal()).attributes;
            expect(attributes).toMatchObject({
                result: 'success',
                usage_coverage: coverage,
                pricing_coverage: coverage,
                llm_call_count: 1,
            });
            expect(attributes.total_tokens).toBe(tokens);
            expect(attributes.cost_usd_micros).toBe(cost);
        }
    );

    it('user receives a failed durable finish in both the public result and typed analytics without another request', async () => {
        fixture.database.exec(`CREATE TEMP TRIGGER reject_finish BEFORE UPDATE ON session_turns
            WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture terminal refusal'); END;`);
        network.replies.push(response('unsaved completion'));
        const started = await fixture.window.api.startTask({ prompt: 'reject the durable finish' });
        await expect(started.completion).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
        expect((await terminal()).attributes).toMatchObject({
            result: 'failure',
            persistence_result: 'failed',
        });
        expect(network.requests).toHaveLength(1);
    });

    it('user approves a command and gets one successful command outcome without exposing its provider call identity', async () => {
        fixture.database.exec(
            `UPDATE built_in_tools SET config_json = '{"approvalMode":"always"}' WHERE tool_id = 'bash'`
        );
        mockTauriCommand('built_in_tools_start_bash', (payload: unknown) => {
            const { request, events } = payload as {
                request: { executionId: string; command: string; workingDirectory: string };
                events: unknown;
            };
            emitTauriChannelMessage(events, {
                kind: 'completed',
                executionId: request.executionId,
                response: {
                    command: request.command,
                    shell: 'powershell',
                    workingDirectory: request.workingDirectory,
                    exitCode: 0,
                    success: true,
                    timedOut: false,
                    cancelled: false,
                    durationMs: 10,
                    stdout: 'fixture output',
                    stderr: '',
                    combinedOutput: 'fixture output',
                },
            });
        });
        network.replies.push(
            toolResponse([
                {
                    id: 'approved-command',
                    name: 'builtin__bash',
                    arguments: JSON.stringify({
                        command: 'Write-Output fixture',
                        reason: 'fixture approval',
                        workingDirectory: 'C:/fixture',
                    }),
                },
            ]),
            response('command completed')
        );
        const started = await fixture.window.api.startTask({ prompt: 'approve the command' });
        await expect
            .poll(() => fixture.window.api.getTaskSnapshot(started.taskId)?.pendingToolApproval)
            .toBeTruthy();
        const decision = fixture.window.api.getTaskSnapshot(started.taskId)!.pendingToolApproval!;
        fixture.window.api.approveTaskToolCall(
            started.taskId,
            decision.callId,
            decision.decisionId
        );
        expect((await started.completion).response).toBe('command completed');
        expect((await terminal()).attributes).toMatchObject({
            result: 'success',
            tool_count: 1,
            approval_count: 1,
        });
        expect(events('agent.approval_resolved')[0]?.attributes.resolution).toBe('approved');
        expect(events('agent.tool_completed')[0]?.attributes).toMatchObject({
            tool_category: 'command',
            result: 'success',
        });
        expect(events('agent.tool_completed')[0]?.attributes.tool_id).not.toBe('approved-command');
        expect(getTauriInvokeCalls('built_in_tools_start_bash')).toHaveLength(1);
    });

    it.each(['capture', 'events', 'release'] as const)(
        'user gets a committed answer without waiting for stalled analytics %s',
        async (stage) => {
            vi.useFakeTimers();
            let finishCapture: (() => void) | undefined;
            const pending: Array<() => void> = [];
            if (stage === 'capture')
                mockTauriCommand(
                    'analytics_begin_operation',
                    () =>
                        new Promise((resolve) => {
                            finishCapture = () =>
                                resolve({
                                    operationId: 'fixture-operation',
                                    enabled: true,
                                    consentEpoch: 3,
                                });
                        })
                );
            if (stage === 'events')
                mockTauriCommand(
                    'analytics_track',
                    () =>
                        new Promise((resolve) => {
                            pending.push(() =>
                                resolve({ status: 'persisted', eventId: 'fixture-event' })
                            );
                        })
                );
            if (stage === 'release')
                mockTauriCommand(
                    'analytics_complete_operation',
                    () =>
                        new Promise<void>((resolve) => {
                            pending.push(resolve);
                        })
                );
            network.replies.push(response('committed independently of analytics'));
            try {
                const started = await fixture.window.api.startTask({
                    prompt: 'analytics must not block the answer',
                });
                expect((await started.completion).response).toBe(
                    'committed independently of analytics'
                );
                expect(fixture.database.prepare('SELECT status FROM session_turns').get()).toEqual({
                    status: 'completed',
                });
                if (stage === 'capture') expect(getTauriInvokeCalls('analytics_track')).toEqual([]);
                finishCapture?.();
                await vi.advanceTimersByTimeAsync(0);
                pending.forEach((resolve) => resolve());
                await vi.advanceTimersByTimeAsync(0);
                expect(events('agent.request_completed')).toHaveLength(1);
                expect(events('agent.request_completed')[0]?.attributes.result).toBe('success');
                expect(getTauriInvokeCalls('analytics_begin_operation')).toHaveLength(1);
                expect(getTauriInvokeCalls('analytics_complete_operation')).toHaveLength(1);
            } finally {
                finishCapture?.();
                pending.forEach((resolve) => resolve());
            }
        }
    );

    it('user gets the committed answer before an analytics-only pricing query settles', async () => {
        vi.useFakeTimers();
        const pending: Array<() => void> = [];
        routeQueriesTo(fixture.database, {
            beforeQuery: ({ sql }) => {
                if (
                    sql.startsWith('select') &&
                    sql.includes('"input_cost_per_million"') &&
                    fixture.database
                        .prepare("SELECT id FROM session_turns WHERE status = 'completed'")
                        .get()
                ) {
                    return new Promise<void>((resolve) => {
                        pending.push(resolve);
                    });
                }
            },
        });
        network.replies.push(response('saved before passive pricing'));
        try {
            const started = await fixture.window.api.startTask({ prompt: 'keep pricing passive' });
            expect((await started.completion).response).toBe('saved before passive pricing');
            await vi.advanceTimersByTimeAsync(0);
            expect(pending).toHaveLength(1);
            expect(events('agent.request_completed')).toEqual([]);
            pending.forEach((resolve) => resolve());
            await vi.advanceTimersByTimeAsync(0);
            expect(events('agent.request_completed')[0]?.attributes).toMatchObject({
                result: 'success',
                persistence_result: 'saved',
            });
            expect(network.requests).toHaveLength(1);
        } finally {
            pending.forEach((resolve) => resolve());
        }
    });

    it.each(['failure', 'cancelled'] as const)(
        'user keeps a %s outcome while analytics capture and event delivery both stall',
        async (outcome) => {
            vi.useFakeTimers();
            let finishCapture!: () => void;
            const pending: Array<() => void> = [];
            mockTauriCommand(
                'analytics_begin_operation',
                () =>
                    new Promise((resolve) => {
                        finishCapture = () =>
                            resolve({
                                operationId: 'fixture-operation',
                                enabled: true,
                                consentEpoch: 3,
                            });
                    })
            );
            mockTauriCommand(
                'analytics_track',
                () =>
                    new Promise((resolve) => {
                        pending.push(() =>
                            resolve({ status: 'persisted', eventId: 'fixture-event' })
                        );
                    })
            );
            const channel = streamingResponse();
            network.replies.push(
                outcome === 'failure'
                    ? Response.json({ error: { message: 'HTTP 401' } }, { status: 401 })
                    : channel.response
            );
            try {
                const started = await fixture.window.api.startTask({
                    prompt: 'do not await telemetry for a failure',
                });
                const result = expect(started.completion).rejects.toMatchObject({
                    code: outcome === 'failure' ? 'UNAUTHORIZED' : 'REQUEST_CANCELLED',
                });
                await vi.advanceTimersByTimeAsync(0);
                if (outcome === 'cancelled') fixture.window.api.cancelTask(started.taskId);
                await result;
                expect(getTauriInvokeCalls('analytics_track')).toEqual([]);
                finishCapture();
                await vi.advanceTimersByTimeAsync(0);
                expect(events('agent.request_completed')[0]?.attributes.result).toBe(outcome);
                pending.forEach((resolve) => resolve());
                await vi.advanceTimersByTimeAsync(0);
                expect(getTauriInvokeCalls('analytics_complete_operation')).toHaveLength(1);
            } finally {
                finishCapture?.();
                pending.forEach((resolve) => resolve());
                channel.fail(new Error('fixture stream closed'));
            }
        }
    );

    it('user cancels retry backoff and keeps the already-started failed call in request coverage', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        network.replies.push(Response.json({ error: { message: 'HTTP 503' } }, { status: 503 }));
        const started = await fixture.window.api.startTask({ prompt: 'cancel the retry backoff' });
        const cancelled = expect(started.completion).rejects.toMatchObject({
            code: 'REQUEST_CANCELLED',
        });
        await vi.waitFor(
            () =>
                expect(
                    fixture.window.api
                        .getTaskSnapshot(started.taskId)
                        ?.sessionHistory.some((message) => message.isRetrying)
                ).toBe(true),
            { timeout: 400, interval: 10 }
        );
        fixture.window.api.cancelTask(started.taskId);
        await cancelled;
        expect((await terminal()).attributes).toMatchObject({
            result: 'cancelled',
            retry_count: 1,
            llm_call_count: 1,
            usage_coverage: 'unavailable',
            unpriced_call_count: 1,
        });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(network.requests).toHaveLength(1);
    });
});
