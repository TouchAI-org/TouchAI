import { createAgentWindowFixture, network, response } from '@tests/utils/agentWindow';
import { mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, it, vi } from 'vitest';

import { createStartupCapabilities } from '@/app/bootstrap/capabilities';

function existingSession(
    database: ReturnType<typeof createAgentWindowFixture>['database'],
    id = 7
) {
    database
        .prepare(
            `INSERT INTO sessions (id, session_id, title, model, provider_id)
        VALUES (?, ?, 'Previous session', 'fixture-model', 1)`
        )
        .run(id, `session-${id}`);
    return id;
}

async function pendingQuestion(input: ReturnType<typeof createAgentWindowFixture>, taskId: string) {
    await expect
        .poll(() => input.window.api.getTaskSnapshot(taskId)?.pendingUserQuestion?.decisionId)
        .toBeTruthy();
    return input.window.api.getTaskSnapshot(taskId)!.pendingUserQuestion!;
}

describe('given the production session commands own no execution loop', () => {
    it('user submits twice during startup and gets one admitted task rather than two turns for the same session', async () => {
        let release!: () => void;
        const capabilities = createStartupCapabilities(() => {});
        capabilities.register(
            'model-metadata',
            new Promise<void>((resolve) => {
                release = resolve;
            })
        );
        const input = createAgentWindowFixture('main', capabilities);
        existingSession(input.database);
        network.replies.push(response('', true));
        try {
            const pending = Promise.allSettled([
                input.window.api.startTask({ prompt: 'first', sessionId: 7 }),
                input.window.api.startTask({ prompt: 'second', sessionId: 7 }),
            ]);
            release();
            const results = await pending;
            const accepted = results.filter((result) => result.status === 'fulfilled');
            const refused = results.filter((result) => result.status === 'rejected');
            expect(accepted).toHaveLength(1);
            expect(refused).toEqual([
                expect.objectContaining({
                    reason: expect.objectContaining({ code: 'SESSION_ACTIVE_TASK_EXISTS' }),
                }),
            ]);
            const task = accepted[0]!;
            if (task.status !== 'fulfilled') throw new Error('No admitted task');
            await pendingQuestion(input, task.value.taskId);
            expect(input.window.api.listActiveTasks()).toHaveLength(1);
            expect(
                input.database.prepare('SELECT count(*) AS count FROM session_turns').get()
            ).toEqual({ count: 1 });
            expect(network.requests).toHaveLength(1);
        } finally {
            release();
            await input.window.dispose();
        }
    });

    it('user reattaches to committed history and cannot corrupt the live task by changing a returned view', async () => {
        const input = createAgentWindowFixture();
        existingSession(input.database);
        input.database.exec(`INSERT INTO messages (id, session_id, role) VALUES (10, 7, 'user');
            INSERT INTO message_parts (message_id, type, content, sort_order) VALUES (10, 'text', 'earlier request', 0);`);
        network.replies.push(response('', true));
        try {
            const started = await input.window.api.startTask({
                prompt: 'current request',
                sessionId: 7,
            });
            await pendingQuestion(input, started.taskId);
            const view = input.window.api.attachSessionView(7)!;
            expect(view.taskId).toBe(started.taskId);
            expect(view.snapshot.sessionHistory[0]?.content).toBe('earlier request');
            view.snapshot.status = 'failed';
            view.snapshot.sessionHistory[0]!.content = 'caller mutation';
            const current = input.window.api.getTaskSnapshot(started.taskId)!;
            expect(current.status).toBe('waiting_approval');
            expect(current.sessionHistory.slice(0, 2)).toMatchObject([
                { content: 'earlier request' },
                { content: 'current request' },
            ]);
            expect(JSON.stringify(input.window.api.getTaskSnapshot(started.taskId))).not.toMatch(
                /fixture-secret|checkpoint_json|prompt_snapshot_json/
            );
            expect(input.window.api.attachSessionView(99)).toBeNull();
        } finally {
            await input.window.dispose();
        }
    });

    it('user runs independent sessions and cancelling one leaves the other question and task live', async () => {
        const input = createAgentWindowFixture();
        existingSession(input.database, 7);
        existingSession(input.database, 8);
        network.replies.push(response('', true), response('', true));
        try {
            const first = await input.window.api.startTask({
                prompt: 'first session',
                sessionId: 7,
            });
            const second = await input.window.api.startBackgroundTask({
                prompt: 'second session',
                sessionId: 8,
            });
            const firstQuestion = await pendingQuestion(input, first.taskId);
            const secondQuestion = await pendingQuestion(input, second.taskId);
            expect(input.window.api.getSessionStatus(7)?.taskId).toBe(first.taskId);
            expect(input.window.api.getSessionStatus(8)?.taskId).toBe(second.taskId);
            expect(
                input.window.api
                    .listActiveTasks()
                    .map((task) => task.executionMode)
                    .sort()
            ).toEqual(['background', 'foreground']);
            expect(input.window.api.cancelTask(first.taskId)).toBe(true);
            await expect(first.completion).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
            expect(
                input.window.api.settleTaskUserQuestion(
                    first.taskId,
                    firstQuestion.callId,
                    null,
                    firstQuestion.decisionId
                )
            ).toBe(false);
            expect(
                input.window.api.getTaskSnapshot(second.taskId)?.pendingUserQuestion?.decisionId
            ).toBe(secondQuestion.decisionId);
            expect(input.window.api.listActiveTasks().map((task) => task.taskId)).toEqual([
                second.taskId,
            ]);
            network.replies.push(response('second session answered'));
            expect(
                input.window.api.settleTaskUserQuestion(
                    second.taskId,
                    secondQuestion.callId,
                    [{ questionIndex: 0, selectedLabels: ['Right'], skipped: false }],
                    secondQuestion.decisionId
                )
            ).toBe(true);
            expect((await second.completion).response).toBe('second session answered');
        } finally {
            await input.window.dispose();
        }
    });

    it('user receives a safe history-read failure with no task or effect and can reuse the session after storage recovers', async () => {
        let refused = true;
        const input = createAgentWindowFixture('main', undefined, {
            beforeQuery: ({ sql }) => {
                if (refused && sql.startsWith('select') && sql.includes('from "sessions"')) {
                    return Promise.reject(new Error('fixture-secret and private SQL failure'));
                }
            },
        });
        existingSession(input.database);
        try {
            const error = await input.window.api
                .startTask({ prompt: 'private request', sessionId: 7 })
                .catch((cause: unknown) => cause);
            expect(error).toMatchObject({ code: 'PERSISTENCE_FAILED' });
            expect(JSON.stringify(error)).not.toMatch(
                /fixture-secret|private request|private SQL|select/
            );
            expect(input.window.api.listActiveTasks()).toEqual([]);
            expect(
                input.database.prepare('SELECT count(*) AS count FROM session_turns').get()
            ).toEqual({ count: 0 });
            expect(network.requests).toEqual([]);
            refused = false;
            network.replies.push(response('storage recovered'));
            const following = await input.window.api.startTask({
                prompt: 'following request',
                sessionId: 7,
            });
            expect((await following.completion).response).toBe('storage recovered');
        } finally {
            await input.window.dispose();
        }
    });

    it('user starts with an already-cancelled signal and receives no hidden task or model request', async () => {
        const input = createAgentWindowFixture();
        const controller = new AbortController();
        controller.abort();
        try {
            await expect(
                input.window.api.startTask({
                    prompt: 'already cancelled',
                    signal: controller.signal,
                })
            ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
            expect(input.window.api.listActiveTasks()).toEqual([]);
            expect(network.requests).toEqual([]);
            expect(
                input.database.prepare('SELECT count(*) AS count FROM session_turns').get()
            ).toEqual({ count: 0 });
        } finally {
            await input.window.dispose();
        }
    });

    it('user starts a new conversation and can attach its view once the native session identity is committed', async () => {
        const input = createAgentWindowFixture();
        network.replies.push(response('', true));
        try {
            const started = await input.window.api.startTask({ prompt: 'new session' });
            await pendingQuestion(input, started.taskId);
            const view = input.window.api.getTaskSnapshot(started.taskId)!;
            expect(view.sessionId).toEqual(expect.any(Number));
            expect(input.database.prepare('SELECT id FROM sessions').get()).toEqual({
                id: view.sessionId,
            });
            expect(input.window.api.attachSessionView(view.sessionId!)?.taskId).toBe(
                started.taskId
            );
            expect(input.window.api.getSessionStatus(99)).toBeNull();
        } finally {
            await input.window.dispose();
        }
    });

    it('user retains the final view for five minutes and can start a following task in the completed session', async () => {
        const input = createAgentWindowFixture();
        await input.window.ready;
        vi.useFakeTimers();
        network.replies.push(response('first complete'), response('following complete'));
        try {
            const first = await input.window.api.startTask({ prompt: 'first' });
            await first.completion;
            const sessionId = input.window.api.getTaskSnapshot(first.taskId)!.sessionId!;
            expect(input.window.api.attachSessionView(sessionId)).toBeNull();
            expect(input.window.api.listActiveTasks()).toEqual([]);
            expect(input.window.api.cancelTask(first.taskId)).toBe(false);
            const second = await input.window.api.startTask({ prompt: 'following', sessionId });
            expect((await second.completion).response).toBe('following complete');
            expect(second.taskId).not.toBe(first.taskId);
            expect(input.window.api.getTaskSnapshot(first.taskId)?.status).toBe('completed');
            await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
            expect(input.window.api.getTaskSnapshot(first.taskId)).toBeNull();
            expect(input.window.api.getTaskSnapshot(second.taskId)).toBeNull();
            expect(input.window.api.cancelTask('missing')).toBe(false);
            expect(() => input.window.api.subscribeTask('missing', () => {})).toThrow(
                expect.objectContaining({ code: 'TASK_NOT_FOUND' })
            );
        } finally {
            await input.window.dispose();
        }
    });

    it('user stops receiving updates after detaching a view while the shared task still completes', async () => {
        const input = createAgentWindowFixture();
        network.replies.push(response('', true));
        try {
            const started = await input.window.api.startTask({ prompt: 'detach this view' });
            const seen: string[] = [];
            const unsubscribe = input.window.api.subscribeTask(started.taskId, (snapshot) =>
                seen.push(snapshot.status)
            );
            expect(seen).toEqual([input.window.api.getTaskSnapshot(started.taskId)!.status]);
            unsubscribe();
            unsubscribe();
            const question = await pendingQuestion(input, started.taskId);
            const before = [...seen];
            network.replies.push(response('completed without the detached view'));
            input.window.api.settleTaskUserQuestion(
                started.taskId,
                question.callId,
                [{ questionIndex: 0, selectedLabels: ['Right'], skipped: false }],
                question.decisionId
            );
            expect((await started.completion).response).toBe('completed without the detached view');
            expect(seen).toEqual(before);
        } finally {
            await input.window.dispose();
        }
    });

    it('user receives live and terminal updates even when another accepted subscriber throws', async () => {
        const input = createAgentWindowFixture();
        network.replies.push(response('', true));
        try {
            const started = await input.window.api.startTask({ prompt: 'independent observers' });
            let throwing = false;
            input.window.api.subscribeTask(started.taskId, () => {
                if (throwing) throw new Error('fixture observer unavailable');
            });
            const seen: string[] = [];
            input.window.api.subscribeTask(started.taskId, (snapshot) =>
                seen.push(snapshot.status)
            );
            throwing = true;
            const question = await pendingQuestion(input, started.taskId);
            expect(seen).toContain('waiting_approval');
            network.replies.push(response('observers do not control execution'));
            input.window.api.settleTaskUserQuestion(
                started.taskId,
                question.callId,
                [{ questionIndex: 0, selectedLabels: ['Right'], skipped: false }],
                question.decisionId
            );
            expect((await started.completion).response).toBe('observers do not control execution');
            expect(seen.at(-1)).toBe('completed');
        } finally {
            await input.window.dispose();
        }
    });

    it('user dismisses a live question and the task cancels without another effect while the session remains reusable', async () => {
        const input = createAgentWindowFixture();
        existingSession(input.database);
        network.replies.push(response('', true));
        try {
            const started = await input.window.api.startTask({
                prompt: 'question to dismiss',
                sessionId: 7,
            });
            const question = await pendingQuestion(input, started.taskId);
            expect(
                input.window.api.settleTaskUserQuestion(
                    started.taskId,
                    question.callId,
                    null,
                    question.decisionId
                )
            ).toBe(true);
            await expect(started.completion).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
            expect(input.window.api.getTaskSnapshot(started.taskId)).toMatchObject({
                status: 'cancelled',
                pendingUserQuestion: null,
                pendingApprovals: [],
            });
            expect(input.window.api.listActiveTasks()).toEqual([]);
            expect(network.requests).toHaveLength(1);
            expect(
                input.window.api.settleTaskUserQuestion(
                    started.taskId,
                    question.callId,
                    null,
                    question.decisionId
                )
            ).toBe(false);
            network.replies.push(response('session reused after dismissal'));
            const following = await input.window.api.startTask({
                prompt: 'following request',
                sessionId: 7,
            });
            expect((await following.completion).response).toBe('session reused after dismissal');
        } finally {
            await input.window.dispose();
        }
    });

    it('user rejects reused approval calls with live identities and an old reply cannot authorize an effect', async () => {
        const input = createAgentWindowFixture();
        const effects: string[] = [];
        for (const command of ['built_in_tools_execute_bash', 'built_in_tools_start_bash']) {
            mockTauriCommand(command, () => {
                effects.push(command);
                throw new Error('Unexpected shell effect');
            });
        }
        const tool = {
            name: 'builtin__bash',
            arguments: JSON.stringify({
                command: 'Remove-Item fixture.txt',
                reason: 'Remove the disposable fixture after confirmation',
                workingDirectory: 'C:/fixture',
            }),
        };
        network.replies.push(
            response('', false, tool),
            response('', false, tool),
            response('both declined')
        );
        try {
            const started = await input.window.api.startTask({ prompt: 'approval boundaries' });
            await expect
                .poll(
                    () =>
                        input.window.api.getTaskSnapshot(started.taskId)?.pendingToolApproval
                            ?.decisionId
                )
                .toBeTruthy();
            const first = input.window.api.getTaskSnapshot(started.taskId)!.pendingToolApproval!;
            expect(input.window.api.approveTaskToolCall(started.taskId, first.callId)).toBe(false);
            expect(
                input.window.api.rejectTaskToolCall(started.taskId, first.callId, first.decisionId)
            ).toBe(true);
            await expect
                .poll(
                    () =>
                        input.window.api.getTaskSnapshot(started.taskId)?.pendingToolApproval
                            ?.decisionId
                )
                .not.toBe(first.decisionId);
            await expect
                .poll(
                    () =>
                        input.window.api.getTaskSnapshot(started.taskId)?.pendingToolApproval
                            ?.decisionId
                )
                .toBeTruthy();
            const second = input.window.api.getTaskSnapshot(started.taskId)!.pendingToolApproval!;
            expect(second.callId).toBe(first.callId);
            expect(
                input.window.api.approveTaskToolCall(started.taskId, first.callId, first.decisionId)
            ).toBe(false);
            expect(input.window.api.rejectTaskToolCall(started.taskId)).toBe(true);
            expect((await started.completion).response).toBe('both declined');
            expect(effects).toEqual([]);
            expect(input.window.api.approveTaskToolCall(started.taskId)).toBe(false);
            expect(
                input.database
                    .prepare(
                        "SELECT json_extract(data, '$.status') AS status FROM message_parts WHERE type = 'tool_call' ORDER BY id"
                    )
                    .all()
            ).toEqual([{ status: 'rejected' }, { status: 'rejected' }]);
        } finally {
            await input.window.dispose();
        }
    });

    it('user closes main and both pending tasks settle without retaining dead decisions or another execution host', async () => {
        const input = createAgentWindowFixture();
        network.replies.push(response('', true), response('', true));
        const first = await input.window.api.startTask({ prompt: 'first task' });
        const second = await input.window.api.startBackgroundTask({ prompt: 'second task' });
        await pendingQuestion(input, first.taskId);
        await pendingQuestion(input, second.taskId);
        await input.window.dispose();
        await expect(first.completion).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        await expect(second.completion).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        expect(input.window.api.listActiveTasks()).toEqual([]);
        expect(input.window.api.getTaskSnapshot(first.taskId)).toBeNull();
        await expect(input.window.api.startTask({ prompt: 'after close' })).rejects.toMatchObject({
            code: 'AGENT_DISPOSED',
        });
        expect(network.requests).toHaveLength(2);
    });
});
