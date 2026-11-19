import { listen } from '@tauri-apps/api/event';
import { routeQueriesTo } from '@tests/database/sqliteHarness';
import {
    createAgentWindowFixture,
    network,
    response,
    responseFromDeltas,
    streamingResponse,
    toolResponse,
} from '@tests/utils/agentWindow';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskViewSnapshot } from '@/app/api/agent/contracts';
import { setLocale, tt } from '@/i18n';
import type { UsageProgress } from '@/modules/usage';

let fixture: ReturnType<typeof createAgentWindowFixture>;
beforeEach(async () => {
    setLocale('zh-CN');
    fixture = createAgentWindowFixture();
    await fixture.window.ready;
    await fixture.window.capabilities.waitForAgent();
    await fixture.window.settings.initialize();
    setLocale('zh-CN');
});
afterEach(async () => {
    await fixture.window.dispose();
    vi.restoreAllMocks();
    setLocale('zh-CN');
});

const text = (snapshot: TaskViewSnapshot | null) =>
    snapshot?.sessionHistory.map((message) => message.content).join('\n') ?? '';

describe('given a production main task with actual Provider, Core and committed history', () => {
    it('user sees the new conversation and turn saved before the network request begins', async () => {
        network.respondToGeneration = async () => {
            expect(fixture.database.prepare('SELECT status FROM session_turns').get()).toEqual({
                status: 'streaming',
            });
            expect(
                fixture.database
                    .prepare('SELECT count(*) AS count FROM session_turn_attempts')
                    .get()
            ).toEqual({ count: 1 });
            expect(
                fixture.database
                    .prepare("SELECT content FROM message_parts WHERE type = 'text'")
                    .get()
            ).toEqual({ content: 'new request' });
            return response('durable answer');
        };
        const started = await fixture.window.api.startTask({ prompt: 'new request' });
        const result = await started.completion;
        expect(result).toMatchObject({
            response: 'durable answer',
            model: { providerName: 'Fixture', modelId: 'fixture-model' },
            turn: { id: expect.any(Number), sessionId: expect.any(Number), status: 'completed' },
        });
        expect(fixture.window.api.getTaskSnapshot(started.taskId)).toMatchObject({
            sessionId: result.turn?.sessionId,
            turnId: result.turn?.id,
        });
    });

    it('user receives a refused start barrier without a hidden model request and can start again after storage recovers', async () => {
        fixture.database
            .exec(`CREATE TEMP TRIGGER reject_start BEFORE INSERT ON session_turn_attempts
            BEGIN SELECT RAISE(ABORT, 'fixture start refusal'); END;`);
        const failed = await fixture.window.api.startTask({ prompt: 'unsaved request' });
        await expect(failed.completion).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
        expect(network.requests).toEqual([]);
        expect(fixture.database.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({
            count: 0,
        });
        fixture.database.exec('DROP TRIGGER reject_start');
        network.replies.push(response('recovered answer'));
        expect(
            (await (await fixture.window.api.startTask({ prompt: 'saved request' })).completion)
                .response
        ).toBe('recovered answer');
    });

    it('user receives a refused terminal barrier rather than a false durable completion and can use the session after recovery', async () => {
        fixture.database.exec(`INSERT INTO sessions (id, session_id, title, model, provider_id)
            VALUES (7, 'terminal-failure', 'Terminal failure', 'fixture-model', 1);
            CREATE TEMP TRIGGER reject_finish BEFORE UPDATE ON session_turns
            WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture terminal refusal'); END;`);
        network.replies.push(response('not durably completed'));
        const failed = await fixture.window.api.startTask({
            sessionId: 7,
            prompt: 'refused finish',
        });
        await expect(failed.completion).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
        expect(fixture.window.api.getTaskSnapshot(failed.taskId)?.status).toBe('failed');
        expect(fixture.database.prepare('SELECT status FROM session_turns').get()).toEqual({
            status: 'streaming',
        });
        fixture.database.exec('DROP TRIGGER reject_finish');
        network.replies.push(response('following durable answer'));
        expect(
            (
                await (
                    await fixture.window.api.startTask({ sessionId: 7, prompt: 'after recovery' })
                ).completion
            ).response
        ).toBe('following durable answer');
    });

    it('user submits a background task and retains its requested mode without needing an attached view', async () => {
        network.replies.push(response('background answer'));
        const started = await fixture.window.api.startBackgroundTask({
            prompt: 'run in the background',
        });
        expect((await started.completion).response).toBe('background answer');
        expect(fixture.window.api.getTaskSnapshot(started.taskId)).toMatchObject({
            executionMode: 'background',
            status: 'completed',
        });
        expect(fixture.database.prepare('SELECT execution_mode FROM session_turns').get()).toEqual({
            execution_mode: 'background',
        });
    });

    it.each([401, 403])(
        'user receives the classified HTTP %s authentication failure without retrying or exposing the response body',
        async (status) => {
            setLocale('en-US');
            network.replies.push(
                Response.json(
                    { error: { message: 'fixture-secret and private upstream body' } },
                    { status }
                )
            );
            const started = await fixture.window.api.startTask({
                prompt: 'authentication must not retry',
            });
            await expect(started.completion).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
            expect(fixture.window.api.getTaskSnapshot(started.taskId)?.error).toBe(
                'Authentication failed. Check the API key.'
            );
            expect(JSON.stringify(fixture.window.api.getTaskSnapshot(started.taskId))).not.toMatch(
                /fixture-secret|private upstream body/
            );
            expect(network.requests).toHaveLength(1);
            expect(
                fixture.database
                    .prepare('SELECT count(*) AS count FROM session_turn_attempts')
                    .get()
            ).toEqual({ count: 1 });
        }
    );

    it('user retries a temporary failure with one frozen prompt and sees changed language only on the following task', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        network.respondToGeneration = async () => {
            if (network.requests.length === 1) {
                setLocale('en-US');
                return Response.json({ error: { message: 'HTTP 503' } }, { status: 503 });
            }
            return response('after a temporary failure');
        };
        const started = await fixture.window.api.startTask({ prompt: 'keep this prompt frozen' });
        const snapshots: TaskViewSnapshot[] = [];
        const stop = fixture.window.api.subscribeTask(started.taskId, (snapshot) =>
            snapshots.push(snapshot)
        );
        try {
            await vi.advanceTimersByTimeAsync(2000);
            expect((await started.completion).response).toBe('after a temporary failure');
            expect(network.requests).toHaveLength(2);
            expect(network.requests[1]?.messages).toEqual(network.requests[0]?.messages);
            expect(
                snapshots.some((snapshot) =>
                    snapshot.sessionHistory.some(
                        (message) => message.isRetrying && /Retrying/.test(message.content)
                    )
                )
            ).toBe(true);
            expect(
                fixture.database
                    .prepare(
                        'SELECT status, error_message FROM session_turn_attempts ORDER BY attempt_index'
                    )
                    .all()
            ).toMatchObject([
                { status: 'failed', error_message: tt('服务暂时不可用，请稍后重试') },
                { status: 'completed' },
            ]);
            await (
                await fixture.window.api.startTask({
                    prompt: 'a new prompt after the language change',
                })
            ).completion;
            expect((network.requests.at(-1)?.messages as unknown[])[0]).not.toEqual(
                (network.requests[0]?.messages as unknown[])[0]
            );
        } finally {
            stop();
        }
    });

    it('user cancels during retry backoff and no later request or attempt starts', async () => {
        vi.useFakeTimers();
        network.replies.push(Response.json({ error: { message: 'HTTP 429' } }, { status: 429 }));
        const started = await fixture.window.api.startTask({
            prompt: 'cancel during the retry wait',
        });
        const failure = expect(started.completion).rejects.toMatchObject({
            code: 'REQUEST_CANCELLED',
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(text(fixture.window.api.getTaskSnapshot(started.taskId))).toContain(
            tt('重试中...({attempt}/{maxRetries})', { attempt: 1, maxRetries: 5 })
        );
        expect(fixture.window.api.cancelTask(started.taskId)).toBe(true);
        await failure;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(network.requests).toHaveLength(1);
        expect(fixture.window.api.getTaskSnapshot(started.taskId)?.status).toBe('cancelled');
    });

    it('user exhausts the existing five retries and sees one final classified failure rather than an unbounded loop', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        network.respondToGeneration = async () =>
            Response.json({ error: { message: 'HTTP 429' } }, { status: 429 });
        const started = await fixture.window.api.startTask({ prompt: 'bounded retry' });
        const failure = expect(started.completion).rejects.toMatchObject({ code: 'RATE_LIMIT' });
        void failure.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(30_000);
        await failure;
        expect(network.requests).toHaveLength(6);
        expect(
            fixture.database.prepare('SELECT count(*) AS count FROM session_turn_attempts').get()
        ).toEqual({ count: 6 });
        expect(fixture.window.api.getTaskSnapshot(started.taskId)?.status).toBe('failed');
    });

    it('user loses a partial stream and retries without retaining its discarded answer in committed history', async () => {
        const first = streamingResponse();
        network.replies.push(first.response, response('only the recovered answer'));
        const started = await fixture.window.api.startTask({ prompt: 'recover a partial answer' });
        first.delta({ role: 'assistant', content: 'discarded partial answer' });
        await expect
            .poll(() => text(fixture.window.api.getTaskSnapshot(started.taskId)))
            .toContain('discarded partial answer');
        first.fail(new Error('network connection lost'));
        expect((await started.completion).response).toBe('only the recovered answer');
        const sessionId = fixture.window.api.getTaskSnapshot(started.taskId)!.sessionId!;
        expect(JSON.stringify(await fixture.window.api.loadSession(sessionId))).not.toContain(
            'discarded partial answer'
        );
        expect(network.requests).toHaveLength(2);
    });

    it('user retries after a committed tool checkpoint and does not execute that completed remote effect twice', async () => {
        vi.useFakeTimers();
        fixture.database.exec(`INSERT INTO mcp_servers (id, name, transport_type, url, enabled)
            VALUES (4, 'Documents', 'http', 'https://fixture.invalid/mcp', 1);`);
        mockTauriCommand('mcp_get_client_status', { server_id: 4, status: 'connected' });
        mockTauriCommand('mcp_list_tools', [
            { name: 'read_document', input_schema: { type: 'object', properties: {} } },
        ]);
        mockTauriCommand('mcp_call_tool', {
            success: true,
            is_error: false,
            content: [{ type: 'text', text: 'completed remote evidence' }],
        });
        await fixture.window.mcp.connectServer(4);
        network.replies.push(
            toolResponse([{ id: 'remote-effect', name: 'mcp__4__read_document', arguments: '{}' }]),
            Response.json({ error: { message: 'HTTP 503' } }, { status: 503 }),
            response('answer from the safe checkpoint')
        );
        const started = await fixture.window.api.startTask({
            prompt: 'resume safely after the read',
        });
        await vi.advanceTimersByTimeAsync(2000);
        expect((await started.completion).response).toBe('answer from the safe checkpoint');
        expect(getTauriInvokeCalls('mcp_call_tool')).toHaveLength(1);
        expect(network.requests).toHaveLength(3);
        expect(JSON.stringify(network.requests.at(-1))).toContain('completed remote evidence');
    });

    it('user cancels a partial answer and restores that saved text with one cancelled terminal status', async () => {
        const first = streamingResponse();
        network.replies.push(first.response);
        const started = await fixture.window.api.startTask({ prompt: 'cancel this stream' });
        first.delta({ role: 'assistant', content: 'saved partial answer' });
        await expect
            .poll(() => text(fixture.window.api.getTaskSnapshot(started.taskId)))
            .toContain('saved partial answer');
        const failure = expect(started.completion).rejects.toMatchObject({
            code: 'REQUEST_CANCELLED',
        });
        fixture.window.api.cancelTask(started.taskId);
        await failure;
        const snapshot = fixture.window.api.getTaskSnapshot(started.taskId)!;
        expect(snapshot.status).toBe('cancelled');
        expect(
            (await fixture.window.api.loadSession(snapshot.sessionId!)).history.at(-1)
        ).toMatchObject({ content: 'saved partial answer', statusText: tt('请求已取消') });
        first.fail(new Error('late network completion'));
        expect(network.requests).toHaveLength(1);
    });

    it('user streams reasoning before an answer and reopens ordered completed presentation parts', async () => {
        network.replies.push(
            responseFromDeltas([
                { role: 'assistant', reasoning_content: 'reasoning evidence' },
                { content: 'visible answer' },
            ])
        );
        const started = await fixture.window.api.startTask({ prompt: 'keep reasoning separate' });
        expect(await started.completion).toMatchObject({
            response: 'visible answer',
            reasoning: 'reasoning evidence',
        });
        const snapshot = fixture.window.api.getTaskSnapshot(started.taskId)!;
        expect(
            (await fixture.window.api.loadSession(snapshot.sessionId!)).history.at(-1)?.parts
        ).toMatchObject([
            { type: 'reasoning', content: 'reasoning evidence', isStreaming: false },
            { type: 'text', content: 'visible answer' },
        ]);
    });

    it.each(['priced', 'unpriced', 'failed lookup'] as const)(
        'user finishes a %s stream and sees finalized usage without pricing blocking the answer',
        async (pricing) => {
            if (pricing === 'priced')
                fixture.database
                    .exec(`INSERT INTO llm_metadata (model_id, name, modalities, input_cost_per_million, output_cost_per_million)
            VALUES ('fixture-model', 'Fixture', '[]', '2', '3');`);
            if (pricing === 'failed lookup') {
                let refused = false;
                routeQueriesTo(fixture.database, {
                    beforeQuery: ({ sql }) => {
                        if (
                            !refused &&
                            sql.startsWith('select') &&
                            sql.includes('"input_cost_per_million"')
                        ) {
                            refused = true;
                            throw new Error('fixture live pricing lookup refusal');
                        }
                    },
                });
            }
            const progress: UsageProgress[] = [];
            const stop = await listen<UsageProgress>('session:task:usage-progress', (event) =>
                progress.push(event.payload)
            );
            network.replies.push(response('visible answer'));
            try {
                const started = await fixture.window.api.startTask({
                    prompt: 'report observed usage',
                });
                expect((await started.completion).response).toBe('visible answer');
                expect(progress.at(-1)).toMatchObject({
                    taskId: started.taskId,
                    outputTokens: 5,
                    streaming: false,
                });
                if (pricing === 'priced')
                    expect(progress.at(-1)?.estimatedCostMicros).not.toBeNull();
                else expect(progress.at(-1)?.estimatedCostMicros).toBeNull();
            } finally {
                stop();
            }
        }
    );
});
