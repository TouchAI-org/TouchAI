import {
    flushObservability,
    initObservability,
    resetObservabilityForTests,
} from '@services/ObservabilityService';
import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { deferred } from '@tests/utils/productAnalytics';
import { installSkillCommands, skillFile, widgetSkillFile } from '@tests/utils/skills';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { AiErrorCode } from '@/services/AgentService/contracts/errors';
import type { AiStreamChunk } from '@/services/AgentService/contracts/protocol';
import { AiRequestExecutor } from '@/services/AgentService/execution';
import {
    AiConversationRuntime,
    type RuntimePersistenceIssue,
    type RuntimeTurnEvent,
} from '@/services/AgentService/execution/runtime';
import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments';
import { loadSessionHistory } from '@/services/AgentService/session/history';
import { SessionTaskCenter } from '@/services/AgentService/task/center';
import { PendingMessagePersistence } from '@/services/AgentService/task/pendingMessagePersistence';
import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { PendingUserMessage, SessionTaskSnapshot } from '@/services/AgentService/task/types';
import { eventService } from '@/services/EventService';
import { AppEvent } from '@/services/EventService/types';
import type { InputHistorySnapshot } from '@/types/session';

const { httpFetch } = vi.hoisted(() => ({ httpFetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));

const privateMarker = 'PRIVATE_SKILL_BODY_MUST_NOT_LEAVE_EXECUTION';
const ownedTaskCenters: SessionTaskCenter[] = [];
let database: ReturnType<typeof openMigratedDatabase>;

function response(toolCall = false, callId = 'skill-call'): Response {
    const delta = toolCall
        ? {
              tool_calls: [
                  {
                      index: 0,
                      id: callId,
                      type: 'function',
                      function: {
                          name: 'builtin__activate_skill',
                          arguments: '{"name":"summary"}',
                      },
                  },
              ],
          }
        : { content: 'Three concise points.' };
    const chunks = [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }] },
    ];
    return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
    );
}

function widgetResponse(name: string, args: Record<string, unknown>, callId = 'widget-call') {
    const input = JSON.stringify(args);
    const split = Math.max(1, Math.floor(input.length / 2));
    const chunks = [
        {
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: callId,
                                type: 'function',
                                function: { name, arguments: input.slice(0, split) },
                            },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        },
        {
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [{ index: 0, function: { arguments: input.slice(split) } }],
                    },
                    finish_reason: null,
                },
            ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ];
    return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
        {
            headers: { 'content-type': 'text/event-stream' },
        }
    );
}

beforeEach(() => {
    httpFetch.mockReset();
    database = openMigratedDatabase();
    routeQueriesTo(database);
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, api_key, logo) VALUES (1, 'Test', 'openai-compatible', 'https://controlled.test/v1', 'test', '');
        INSERT INTO models (id, provider_id, name, model_id, is_default, tool_call) VALUES (1, 1, 'Test', 'test-model', 1, 1);
        INSERT INTO built_in_tools (tool_id, display_name, enabled, risk_level) VALUES ('activate_skill', 'ActivateSkill', 1, 'medium');
        INSERT INTO built_in_tools (tool_id, display_name, enabled, risk_level) VALUES ('show_widget', 'ShowWidget', 1, 'low');
    `);
    const file = skillFile();
    installSkillCommands(
        [{ ...file, content: `${file.frontmatter}${privateMarker}` }],
        [widgetSkillFile()]
    );
    initObservability();
});

afterEach(() => {
    ownedTaskCenters.splice(0).forEach((center) => center.dispose());
    resetObservabilityForTests();
    closeTestDatabases();
});

function priorityMessage(id: string, prompt: string): PendingUserMessage {
    return { id, prompt, attachments: [], delivery: 'priority', createdAt: Date.now() };
}

function cachedAttachment(type: AttachmentIndex['type']): AttachmentIndex {
    const hash = 'a'.repeat(64);
    const name = type === 'image' ? 'photo.png' : 'notes.txt';
    const mimeType = type === 'image' ? 'image/png' : 'text/plain';
    const originPath = `/test/${name}`;
    database
        .prepare(
            `INSERT INTO attachments (id, hash, type, original_name, origin_path, mime_type)
        VALUES (1, ?, ?, ?, ?, ?)`
        )
        .run(hash, type, name, originPath, mimeType);
    return {
        id: 'cached-attachment',
        attachmentId: 1,
        hash,
        type,
        name,
        path: `/test/cache/${name}`,
        originPath,
        mimeType,
        supportStatus: 'supported',
    };
}

function durablePriorityRun(
    messages: PendingUserMessage[],
    onStart?: () => void,
    sessionId?: number,
    inputSnapshot?: InputHistorySnapshot
) {
    const persistence = new PendingMessagePersistence();
    const state = {
        sessionId: sessionId ?? null,
        pending: [...messages],
        claimed: new Set<string>(),
        events: [] as RuntimeTurnEvent[],
        issues: [] as RuntimePersistenceIssue[],
    };
    const runtime = new AiConversationRuntime(new AiRequestExecutor(), {
        prompt: 'Continue the active answer',
        taskId: crypto.randomUUID(),
        sessionId,
        inputSnapshot,
        takePriorityUserMessages: () => {
            const available = state.pending.filter((message) => !state.claimed.has(message.id));
            for (const message of available) state.claimed.add(message.id);
            return available;
        },
        releasePriorityUserMessages: (messageIds) => {
            for (const messageId of messageIds) state.claimed.delete(messageId);
        },
        waitForPendingMessageWrites: async () => {
            if (state.sessionId === null) throw new Error('The session has not been saved');
            await persistence.flush(state.sessionId);
        },
        environment: {
            reportPersistenceIssue: (issue) => {
                state.issues.push(issue);
            },
        },
        onTurnEvent: (event) => {
            state.events.push(event);
            if (event.type === 'task_started') {
                state.sessionId = event.sessionId;
                if (state.sessionId === null) throw new Error('The session has not been saved');
                for (const message of messages) persistence.enqueue(state.sessionId, message);
                onStart?.();
            }
            if (
                event.type === 'user_messages_delivered' ||
                event.type === 'user_messages_rejected'
            ) {
                const settled = new Set(
                    event.type === 'user_messages_delivered'
                        ? event.messages.map((message) => message.id)
                        : event.messageIds
                );
                state.pending = state.pending.filter((message) => !settled.has(message.id));
                for (const messageId of settled) state.claimed.delete(messageId);
            }
        },
    });
    return { runtime, persistence, state };
}

describe('given queued delivery overlaps a storage or cancellation boundary', () => {
    it('user resumes a queued message after its start write fails without sending it before recovery', async () => {
        database.exec(`INSERT INTO sessions (id, session_id, title, model, provider_id)
            VALUES (1, 'queued-recovery', 'Queued recovery', 'test-model', 1)`);
        const message: PendingUserMessage = {
            ...priorityMessage('queued-start', 'Resume the queued input'),
            delivery: 'queue',
            createdAt: Date.parse('2026-11-16T12:00:00Z'),
            modelId: 'test-model',
            providerId: 1,
            inputSnapshot: {
                text: 'Resume the queued input',
                attachments: [],
                skills: [{ name: 'summary', path: skillFile().path }],
                excludeFromHistory: true,
                editorDoc: {
                    type: 'doc',
                    content: [
                        {
                            type: 'paragraph',
                            content: [{ type: 'text', text: 'Resume the queued input' }],
                        },
                    ],
                },
            },
        };
        const persistence = new PendingMessagePersistence();
        persistence.enqueue(1, message);
        await persistence.flush(1);
        database.exec(`CREATE TEMP TRIGGER queued_start_write_failure
            BEFORE INSERT ON session_turn_attempts
            BEGIN SELECT RAISE(ABORT, 'Turn start unavailable'); END`);
        httpFetch.mockImplementation(async () => response());
        const center = new SessionTaskCenter(persistence);
        ownedTaskCenters.push(center);
        const started = await center.startForegroundTask({
            prompt: message.prompt,
            sessionId: 1,
            userMessageId: message.id,
            pendingMessageId: message.id,
            modelId: message.modelId,
            providerId: message.providerId,
            inputSnapshot: message.inputSnapshot,
        });

        await expect(started.completion).rejects.toMatchObject({ code: AiErrorCode.UNKNOWN });
        expect(httpFetch.mock.calls).toEqual([]);
        expect(center.getTaskSnapshot(started.taskId)?.status).toBe('failed');
        expect(center.getSessionStatus(1)).toBeNull();
        expect(database.prepare('SELECT id FROM messages').all()).toEqual([]);
        await expect(new PendingMessagePersistence().load(1)).resolves.toEqual([message]);

        database.exec('DROP TRIGGER queued_start_write_failure');
        center.dispose();
        const recovered = new SessionTaskCenter();
        ownedTaskCenters.push(recovered);
        await expect(recovered.restoreSessionQueue(1)).resolves.toEqual([message]);
        recovered.resumeSessionQueue(1);
        await vi.waitFor(() => {
            expect(
                database
                    .prepare('SELECT content FROM message_parts WHERE content = ?')
                    .all(message.prompt)
            ).toHaveLength(1);
            expect(recovered.getSessionStatus(1)).toBeNull();
        });
        expect(httpFetch.mock.calls).toHaveLength(1);
        await expect(new PendingMessagePersistence().load(1)).resolves.toEqual([]);
    });

    it.each(['no earlier edit', 'an earlier parked edit'] as const)(
        'user keeps an automatic queued start visible in its prior slot and resumes it once with %s',
        async (context) => {
            database.exec(`INSERT INTO sessions (id, session_id, title, model, provider_id)
                VALUES (1, 'live-queue-recovery', 'Live queue recovery', 'test-model', 1)`);
            const parked: PendingUserMessage = {
                ...priorityMessage('parked-input', 'Keep this input parked'),
                delivery: 'queue',
            };
            const failedInput: PendingUserMessage = {
                ...priorityMessage('queued-start', 'Resume the complete queued input'),
                delivery: 'queue',
                createdAt: Date.parse('2026-11-16T12:00:00Z'),
                modelId: 'test-model',
                providerId: 1,
                inputSnapshot: {
                    text: 'Resume the complete queued input',
                    attachments: [],
                    skills: [{ name: 'summary', path: skillFile().path }],
                    excludeFromHistory: true,
                    editorDoc: {
                        type: 'doc',
                        content: [
                            {
                                type: 'paragraph',
                                content: [
                                    { type: 'text', text: 'Resume the complete queued input' },
                                ],
                            },
                        ],
                    },
                },
            };
            const waiting: PendingUserMessage = {
                ...priorityMessage('waiting-input', 'Run after the recovered input'),
                delivery: 'queue',
            };
            const hasParkedEdit = context === 'an earlier parked edit';
            const persistence = new PendingMessagePersistence();
            for (const message of hasParkedEdit
                ? [parked, failedInput, waiting]
                : [failedInput, waiting]) {
                persistence.enqueue(1, message);
            }
            await persistence.flush(1);
            const center = new SessionTaskCenter(persistence);
            ownedTaskCenters.push(center);
            const restored = await center.restoreSessionQueue(1);
            if (hasParkedEdit) {
                expect(center.setSessionUserMessageEditing(1, parked.id, true)).toBe(true);
            }
            const expectedQueue = restored.map((message) =>
                hasParkedEdit && message.id === parked.id ? { ...message, editing: true } : message
            );
            const requests: string[] = [];
            httpFetch.mockImplementation(async (_url, init) => {
                const payload = JSON.parse(init.body) as {
                    messages: Array<{ role: string; content: string }>;
                };
                const userMessages = payload.messages.filter((message) => message.role === 'user');
                requests.push(userMessages[userMessages.length - 1]?.content ?? '');
                return response();
            });
            database.exec(`CREATE TEMP TRIGGER queued_start_write_failure
                BEFORE INSERT ON session_turn_attempts
                BEGIN SELECT RAISE(ABORT, 'Turn start unavailable'); END`);
            const failurePublished = deferred<SessionTaskSnapshot | null>();
            const stopObserving = await eventService.on(
                AppEvent.SESSION_TASK_STATUS_CHANGED,
                (status) => {
                    if (status.sessionId === 1 && status.status === 'failed') {
                        failurePublished.resolve(center.getTaskSnapshot(status.taskId));
                    }
                }
            );
            try {
                center.resumeSessionQueue(1);
                const failed = await failurePublished.promise;
                await persistence.flush(1);

                expect(failed?.status).toBe('failed');
                expect(failed?.pendingUserMessages).toEqual(expectedQueue);
                expect(
                    failed?.sessionHistory.filter((message) => message.id === failedInput.id)
                ).toEqual([]);
                await expect(center.restoreSessionQueue(1)).resolves.toEqual(expectedQueue);
                await expect(new PendingMessagePersistence().load(1)).resolves.toEqual(restored);
                expect(requests).toEqual([]);
                expect(center.getSessionStatus(1)).toBeNull();
                expect(database.prepare('SELECT id FROM messages').all()).toEqual([]);

                database.exec('DROP TRIGGER queued_start_write_failure');
                center.resumeSessionQueue(1);
                await vi.waitFor(() => {
                    expect(requests).toEqual([failedInput.prompt, waiting.prompt]);
                    expect(center.getSessionStatus(1)).toBeNull();
                });
                await persistence.flush(1);
                const remaining = restored.filter(
                    (message) => hasParkedEdit && message.id === parked.id
                );
                await expect(new PendingMessagePersistence().load(1)).resolves.toEqual(remaining);
                expect(
                    database
                        .prepare('SELECT id FROM message_parts WHERE content = ?')
                        .all(failedInput.prompt)
                ).toHaveLength(1);
            } finally {
                stopObserving();
            }
        }
    );

    it('user does not requeue a committed queued message when its model response fails', async () => {
        database.exec(`INSERT INTO sessions (id, session_id, title, model, provider_id)
            VALUES (1, 'committed-queue-failure', 'Committed queue failure', 'test-model', 1)`);
        const sent: PendingUserMessage = {
            ...priorityMessage('committed-input', 'Fail only after this input commits'),
            delivery: 'queue',
        };
        const waiting: PendingUserMessage = {
            ...priorityMessage('waiting-input', 'Keep this input waiting'),
            delivery: 'queue',
        };
        const persistence = new PendingMessagePersistence();
        persistence.enqueue(1, sent);
        persistence.enqueue(1, waiting);
        await persistence.flush(1);
        const center = new SessionTaskCenter(persistence);
        ownedTaskCenters.push(center);
        const restored = await center.restoreSessionQueue(1);
        httpFetch
            .mockResolvedValueOnce(
                new Response('{"error":{"message":"Unauthorized"}}', { status: 401 })
            )
            .mockImplementation(async () => response());
        const failurePublished = deferred<SessionTaskSnapshot | null>();
        const stopObserving = await eventService.on(
            AppEvent.SESSION_TASK_STATUS_CHANGED,
            (status) => {
                if (status.sessionId === 1 && status.status === 'failed') {
                    failurePublished.resolve(center.getTaskSnapshot(status.taskId));
                }
            }
        );
        try {
            center.resumeSessionQueue(1);
            const failed = await failurePublished.promise;
            await persistence.flush(1);

            expect(failed?.turnId).toEqual(expect.any(Number));
            expect(failed?.sessionHistory.filter((message) => message.id === sent.id)).toHaveLength(
                1
            );
            expect(failed?.pendingUserMessages).toEqual(
                restored.filter((message) => message.id === waiting.id)
            );
            await expect(center.restoreSessionQueue(1)).resolves.toEqual(
                failed?.pendingUserMessages
            );
            await expect(new PendingMessagePersistence().load(1)).resolves.toEqual(
                failed?.pendingUserMessages
            );
            expect(
                database.prepare('SELECT id FROM message_parts WHERE content = ?').all(sent.prompt)
            ).toHaveLength(1);
            expect(httpFetch.mock.calls).toHaveLength(1);

            center.resumeSessionQueue(1);
            await vi.waitFor(() => {
                expect(
                    database
                        .prepare('SELECT id FROM message_parts WHERE content = ?')
                        .all(waiting.prompt)
                ).toHaveLength(1);
                expect(center.getSessionStatus(1)).toBeNull();
            });
            await persistence.flush(1);
            await expect(new PendingMessagePersistence().load(1)).resolves.toEqual([]);
            expect(
                database.prepare('SELECT id FROM message_parts WHERE content = ?').all(sent.prompt)
            ).toHaveLength(1);
        } finally {
            stopObserving();
        }
    });

    it('user clears all pending work after a late queued start failure without it returning', async () => {
        database.exec(`INSERT INTO sessions (id, session_id, title, model, provider_id)
            VALUES (1, 'cleared-queue-failure', 'Cleared queue failure', 'test-model', 1)`);
        const persistence = new PendingMessagePersistence();
        for (const message of [
            priorityMessage('failed-input', 'Clear the failed input'),
            priorityMessage('waiting-input', 'Clear the waiting input'),
        ]) {
            persistence.enqueue(1, { ...message, delivery: 'queue' });
        }
        await persistence.flush(1);
        const center = new SessionTaskCenter(persistence);
        ownedTaskCenters.push(center);
        await center.restoreSessionQueue(1);
        database.exec(`CREATE TEMP TRIGGER queued_start_write_failure
            BEFORE INSERT ON session_turn_attempts
            BEGIN SELECT RAISE(ABORT, 'Turn start unavailable'); END`);
        httpFetch.mockImplementation(async () => response());
        const failurePublished = deferred<string>();
        let cleared = false;
        const stopObserving = await eventService.on(
            AppEvent.SESSION_TASK_STATUS_CHANGED,
            (status) => {
                if (status.sessionId === 1 && status.status === 'failed') {
                    cleared = center.clearSessionUserMessages(1);
                    failurePublished.resolve(status.taskId);
                }
            }
        );
        try {
            center.resumeSessionQueue(1);
            const taskId = await failurePublished.promise;
            await persistence.flush(1);

            expect(cleared).toBe(true);
            expect(center.getTaskSnapshot(taskId)?.pendingUserMessages).toEqual([]);
            expect(
                center
                    .getTaskSnapshot(taskId)
                    ?.sessionHistory.filter((message) => message.id === 'failed-input')
            ).toEqual([]);
            await expect(center.restoreSessionQueue(1)).resolves.toEqual([]);
            await expect(new PendingMessagePersistence().load(1)).resolves.toEqual([]);
            database.exec('DROP TRIGGER queued_start_write_failure');
            center.resumeSessionQueue(1);
            const recovered = new SessionTaskCenter();
            ownedTaskCenters.push(recovered);
            await expect(recovered.restoreSessionQueue(1)).resolves.toEqual([]);
            expect(center.getSessionStatus(1)).toBeNull();
            expect(httpFetch.mock.calls).toEqual([]);
        } finally {
            stopObserving();
        }
    });

    it.each(['delivered', 'rejected'] as const)(
        'user cancels during a steer that is then %s and only the other waiting messages run',
        async (outcome) => {
            const firstResponse = deferred<Response>();
            const requests: string[] = [];
            httpFetch.mockImplementation(async (_url, init) => {
                const payload = JSON.parse(init.body) as {
                    messages: Array<{ role: string; content: string }>;
                };
                const userMessages = payload.messages.filter((message) => message.role === 'user');
                const prompt = userMessages[userMessages.length - 1]?.content;
                requests.push(prompt ?? '');
                return requests.length === 1 ? firstResponse.promise : response();
            });
            const persistence = new PendingMessagePersistence();
            const center = new SessionTaskCenter(persistence);
            ownedTaskCenters.push(center);
            const started = await center.startForegroundTask({ prompt: 'Active answer' });
            await vi.waitFor(() => expect(requests).toEqual(['Active answer']));
            const sessionId = center.getTaskSnapshot(started.taskId)?.sessionId;
            if (sessionId === undefined || sessionId === null) throw new Error('Missing session');
            center.enqueueTaskUserMessage(started.taskId, { prompt: 'Waiting one' }, 'queue');
            center.enqueueTaskUserMessage(started.taskId, { prompt: 'Waiting two' }, 'queue');
            const steer = center.enqueueTaskUserMessage(
                started.taskId,
                {
                    prompt: 'Steer during cancellation',
                    ...(outcome === 'rejected'
                        ? {
                              inputSnapshot: {
                                  text: 'Steer during cancellation',
                                  attachments: [],
                                  skills: [{ name: 'summary', path: skillFile().path }],
                              },
                          }
                        : {}),
                },
                'queue'
            );
            if (!steer) throw new Error('Missing steer');
            expect(center.promoteTaskUserMessage(started.taskId, steer.id)).toBe(true);
            let cancelled = false;
            if (outcome === 'delivered') {
                routeQueriesTo(database, {
                    beforeCommit: () => {
                        const saved = database
                            .prepare('SELECT id FROM message_parts WHERE content = ?')
                            .get(steer.prompt);
                        if (!cancelled && saved) {
                            cancelled = center.cancelTask(started.taskId);
                        }
                    },
                });
            } else {
                mockTauriCommand('agent_skills_read_enabled_user_file', () => {
                    cancelled = center.cancelTask(started.taskId);
                    throw new Error('Selected skill unavailable');
                });
            }
            firstResponse.resolve(response());
            await expect(started.completion).rejects.toMatchObject({
                code: AiErrorCode.REQUEST_CANCELLED,
            });
            await vi.waitFor(() => {
                expect(requests[requests.length - 1]).toBe('Waiting two');
                expect(center.getSessionStatus(sessionId)).toBeNull();
            });
            await persistence.flush(sessionId);

            expect(cancelled).toBe(true);
            expect(requests).toEqual(['Active answer', 'Waiting one', 'Waiting two']);
            expect(
                database.prepare('SELECT id FROM message_parts WHERE content = ?').all(steer.prompt)
            ).toHaveLength(outcome === 'delivered' ? 1 : 0);
            await expect(new PendingMessagePersistence().load(sessionId)).resolves.toEqual([]);
            expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([]);
        }
    );
});

describe('given priority messages have a durable queue entry', () => {
    beforeEach(() => {
        httpFetch.mockResolvedValueOnce(response(true)).mockImplementation(async () => response());
    });

    it('user keeps a steer retryable without sending it when its history transaction fails', async () => {
        const { runtime, state } = durablePriorityRun(
            [priorityMessage('pending-1', 'Priority one')],
            () => {
                database.exec(`CREATE TEMP TRIGGER injected_write_failure
                BEFORE INSERT ON message_parts WHEN NEW.type = 'text' AND NEW.content = 'Priority one'
                BEGIN SELECT RAISE(ABORT, 'history storage unavailable'); END`);
            }
        );

        await expect(runtime.run()).rejects.toBeInstanceOf(Error);

        expect(state.pending.map((message) => message.id)).toEqual(['pending-1']);
        expect(state.issues).toContainEqual(
            expect.objectContaining({ phase: 'user_message_delivery' })
        );
        expect(state.events.some((event) => event.type === 'user_messages_delivered')).toBe(false);
        expect(httpFetch.mock.calls.every(([, init]) => !init.body.includes('Priority one'))).toBe(
            true
        );
        expect(
            database
                .prepare("SELECT content FROM message_parts WHERE content = 'Priority one'")
                .all()
        ).toEqual([]);

        database.exec('DROP TRIGGER injected_write_failure');
        const restored = await new PendingMessagePersistence().load(state.sessionId!);
        expect(restored).toEqual([
            expect.objectContaining({ id: 'pending-1', prompt: 'Priority one' }),
        ]);
        httpFetch.mockReset();
        httpFetch.mockResolvedValueOnce(response(true)).mockImplementation(async () => response());
        const recovered = durablePriorityRun(
            restored.map((message) => ({ ...message, delivery: 'priority' })),
            undefined,
            state.sessionId!
        );
        await expect(recovered.runtime.run()).resolves.toMatchObject({
            response: 'Three concise points.',
        });
        expect(recovered.state.pending).toEqual([]);
        await expect(new PendingMessagePersistence().load(state.sessionId!)).resolves.toEqual([]);
        expect(
            database
                .prepare("SELECT content FROM message_parts WHERE content = 'Priority one'")
                .all()
        ).toHaveLength(1);
        expect(httpFetch.mock.calls.some(([, init]) => init.body.includes('Priority one'))).toBe(
            true
        );
    });

    it('user regains a steer claim when the queue cannot reach its durability boundary', async () => {
        const { runtime, persistence, state } = durablePriorityRun(
            [priorityMessage('pending-1', 'Unsaved priority')],
            () => {
                database.exec(`CREATE TEMP TRIGGER pending_write_failure
                BEFORE INSERT ON session_pending_messages
                BEGIN SELECT RAISE(ABORT, 'queue storage unavailable'); END`);
            }
        );
        await expect(runtime.run()).rejects.toBeInstanceOf(Error);
        expect(state.pending.map((message) => message.id)).toEqual(['pending-1']);
        expect(state.claimed.size).toBe(0);
        expect(state.events.some((event) => event.type === 'user_messages_delivered')).toBe(false);
        expect(state.issues).toContainEqual(
            expect.objectContaining({ phase: 'user_message_delivery' })
        );
        expect(
            httpFetch.mock.calls.every(([, init]) => !init.body.includes('Unsaved priority'))
        ).toBe(true);

        database.exec('DROP TRIGGER pending_write_failure');
        await persistence.flush(state.sessionId!);
        await expect(new PendingMessagePersistence().load(state.sessionId!)).resolves.toEqual([
            expect.objectContaining({ id: 'pending-1', prompt: 'Unsaved priority' }),
        ]);
    });

    it.each(['unsupported image', 'unreadable file', 'unavailable skill'] as const)(
        'user rejects a steer with an %s and it never reappears after history reload',
        async (reason) => {
            const message = priorityMessage('pending-1', 'Rejected priority');
            if (reason === 'unavailable skill') {
                message.inputSnapshot = {
                    text: message.prompt,
                    attachments: [],
                    skills: [{ name: 'summary', path: skillFile().path }],
                };
                mockTauriCommand('agent_skills_read_enabled_user_file', () => {
                    throw new Error('Skill file unavailable');
                });
            } else {
                message.attachments = [
                    cachedAttachment(reason === 'unreadable file' ? 'file' : 'image'),
                ];
                if (reason === 'unreadable file') {
                    database.exec(
                        `UPDATE models SET attachment = 1, modalities = '{"input":["text","file"],"output":["text"]}'`
                    );
                    mockTauriCommand('plugin:fs|open', () => {
                        throw new Error('Attachment unavailable');
                    });
                }
            }
            const { runtime, state } = durablePriorityRun([message]);
            await expect(runtime.run()).resolves.toMatchObject({
                response: 'Three concise points.',
            });
            expect(state.pending).toEqual([]);
            expect(state.events).toContainEqual(
                expect.objectContaining({
                    type: 'user_messages_rejected',
                    messageIds: ['pending-1'],
                })
            );
            expect(state.events.some((event) => event.type === 'user_messages_delivered')).toBe(
                false
            );
            await expect(new PendingMessagePersistence().load(state.sessionId!)).resolves.toEqual(
                []
            );
            expect(
                httpFetch.mock.calls.every(([, init]) => !init.body.includes(message.prompt))
            ).toBe(true);
        }
    );

    it('user retains a rejected steer for recovery when its durable removal fails', async () => {
        const message = priorityMessage('pending-1', 'Keep rejected priority');
        message.inputSnapshot = {
            text: message.prompt,
            attachments: [],
            skills: [{ name: 'summary', path: skillFile().path }],
        };
        mockTauriCommand('agent_skills_read_enabled_user_file', () => {
            throw new Error('Skill file unavailable');
        });
        const { runtime, state } = durablePriorityRun([message], () => {
            database.exec(`CREATE TEMP TRIGGER pending_delete_failure
                BEFORE DELETE ON session_pending_messages
                BEGIN SELECT RAISE(ABORT, 'queue removal unavailable'); END`);
        });

        await expect(runtime.run()).rejects.toBeInstanceOf(Error);
        expect(state.pending.map((pending) => pending.id)).toEqual(['pending-1']);
        expect(state.claimed.size).toBe(0);
        expect(state.events.some((event) => event.type === 'user_messages_rejected')).toBe(false);
        expect(state.events.some((event) => event.type === 'user_messages_delivered')).toBe(false);
        expect(state.issues).toContainEqual(
            expect.objectContaining({ phase: 'user_message_delivery' })
        );
        await expect(new PendingMessagePersistence().load(state.sessionId!)).resolves.toEqual([
            expect.objectContaining({
                id: 'pending-1',
                prompt: message.prompt,
                inputSnapshot: expect.objectContaining({ skills: message.inputSnapshot.skills }),
            }),
        ]);
    });

    it('user restores only uncommitted steers when a later message in the same batch fails', async () => {
        const messages = [
            priorityMessage('pending-1', 'First committed priority'),
            priorityMessage('pending-2', 'Second failed priority'),
        ];
        const { runtime, state } = durablePriorityRun(messages, () => {
            database.exec(`CREATE TEMP TRIGGER injected_write_failure
                BEFORE INSERT ON message_parts WHEN NEW.type = 'text' AND NEW.content = 'Second failed priority'
                BEGIN SELECT RAISE(ABORT, 'history storage unavailable'); END`);
        });
        await expect(runtime.run()).rejects.toBeInstanceOf(Error);
        expect(state.pending.map((message) => message.id)).toEqual(['pending-2']);
        expect(state.events).toContainEqual(
            expect.objectContaining({
                type: 'user_messages_delivered',
                messages: [expect.objectContaining({ id: 'pending-1' })],
            })
        );
        const restored = await new PendingMessagePersistence().load(state.sessionId!);
        expect(restored).toEqual([
            expect.objectContaining({ id: 'pending-2', prompt: 'Second failed priority' }),
        ]);
        expect(
            database
                .prepare(
                    "SELECT content FROM message_parts WHERE content = 'First committed priority'"
                )
                .all()
        ).toHaveLength(1);
        expect(
            database
                .prepare(
                    "SELECT content FROM message_parts WHERE content = 'Second failed priority'"
                )
                .all()
        ).toEqual([]);

        database.exec('DROP TRIGGER injected_write_failure');
        httpFetch.mockReset();
        httpFetch.mockResolvedValueOnce(response(true)).mockImplementation(async () => response());
        const recovered = durablePriorityRun(
            restored.map((message) => ({ ...message, delivery: 'priority' })),
            undefined,
            state.sessionId!
        );
        await expect(recovered.runtime.run()).resolves.toMatchObject({
            response: 'Three concise points.',
        });
        await expect(new PendingMessagePersistence().load(state.sessionId!)).resolves.toEqual([]);
        expect(
            database
                .prepare(
                    "SELECT content FROM message_parts WHERE content = 'First committed priority'"
                )
                .all()
        ).toHaveLength(1);
        expect(
            database
                .prepare(
                    "SELECT content FROM message_parts WHERE content = 'Second failed priority'"
                )
                .all()
        ).toHaveLength(1);
    });
});

describe('given pending inputs become ordinary messages in an active conversation', () => {
    beforeEach(() => {
        httpFetch.mockResolvedValueOnce(response(true)).mockImplementation(async () => response());
    });

    it('user reloads ordinary and inserted messages with their own committed input metadata', async () => {
        const initialInput: InputHistorySnapshot = {
            text: 'Continue the active answer',
            attachments: [],
            skills: [{ name: 'widget', path: widgetSkillFile().path }],
            editorDoc: {
                type: 'doc',
                content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'Original input' }] },
                ],
            },
            excludeFromHistory: true,
        };
        const messages = [
            priorityMessage('with-all-metadata', '总结这段中文输入'),
            priorityMessage('with-editor', 'Keep this formatted input'),
            priorityMessage('with-history-flag', 'Exclude only this input'),
            priorityMessage('without-metadata', 'Plain inserted input'),
            priorityMessage('skill-only', ''),
        ];
        messages[0]!.inputSnapshot = {
            text: messages[0]!.prompt,
            attachments: [],
            skills: [{ name: 'summary', path: skillFile().path }],
            editorDoc: {
                type: 'doc',
                content: [
                    { type: 'paragraph', content: [{ type: 'text', text: messages[0]!.prompt }] },
                ],
            },
            excludeFromHistory: true,
        };
        messages[1]!.inputSnapshot = {
            text: messages[1]!.prompt,
            attachments: [],
            editorDoc: {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            { type: 'text', marks: [{ type: 'bold' }], text: messages[1]!.prompt },
                        ],
                    },
                ],
            },
        };
        messages[2]!.inputSnapshot = {
            text: messages[2]!.prompt,
            attachments: [],
            excludeFromHistory: true,
        };
        messages[4]!.inputSnapshot = {
            text: '',
            attachments: [],
            skills: [{ name: 'summary', path: skillFile().path }],
        };
        const { runtime, state } = durablePriorityRun(messages, undefined, undefined, initialInput);

        await expect(runtime.run()).resolves.toMatchObject({ response: 'Three concise points.' });
        const history = await loadSessionHistory(state.sessionId!);

        expect(
            history
                .filter((message) => message.role === 'user')
                .map((message) => message.inputSnapshot)
        ).toEqual([
            initialInput,
            ...messages.map(
                (message) =>
                    message.inputSnapshot ?? {
                        text: message.prompt,
                        attachments: [],
                    }
            ),
        ]);
        expect(state.pending).toEqual([]);
        await expect(new PendingMessagePersistence().load(state.sessionId!)).resolves.toEqual([]);
        expect(database.prepare('SELECT id FROM session_turns').all()).toHaveLength(1);
        expect(database.prepare('SELECT id FROM session_turn_attempts').all()).toHaveLength(1);
        for (const table of ['session_turns', 'session_turn_attempts', 'message_parts']) {
            expect(JSON.stringify(database.prepare(`SELECT * FROM ${table}`).all())).not.toContain(
                privateMarker
            );
        }
        expect(JSON.stringify(state.events)).not.toContain(privateMarker);
        expect(state.events).toContainEqual(
            expect.objectContaining({
                type: 'prompt_snapshot_ready',
                snapshot: expect.objectContaining({
                    userPrompt: initialInput.text,
                    inputSnapshot: {
                        skills: initialInput.skills,
                        editorDoc: initialInput.editorDoc,
                        excludeFromHistory: true,
                    },
                }),
            })
        );
    });

    it.each(['snapshot write', 'pending removal', 'transaction commit'] as const)(
        'user retains the complete pending input when %s fails and restores its metadata after explicit recovery',
        async (failure) => {
            const message = priorityMessage('recover-input', 'Recover the complete inserted input');
            message.inputSnapshot = {
                text: message.prompt,
                attachments: [],
                skills: [{ name: 'summary', path: skillFile().path }],
                editorDoc: {
                    type: 'doc',
                    content: [
                        { type: 'paragraph', content: [{ type: 'text', text: message.prompt }] },
                    ],
                },
                excludeFromHistory: true,
            };
            const { runtime, state } = durablePriorityRun([message], () => {
                if (failure === 'transaction commit') {
                    let failurePending = true;
                    routeQueriesTo(database, {
                        beforeCommit: () => {
                            if (
                                failurePending &&
                                database
                                    .prepare('SELECT id FROM message_parts WHERE content = ?')
                                    .get(message.prompt)
                            ) {
                                failurePending = false;
                                throw new Error('Input commit unavailable');
                            }
                        },
                    });
                } else {
                    database.exec(
                        failure === 'snapshot write'
                            ? `CREATE TEMP TRIGGER input_handoff_failure
                            BEFORE UPDATE OF prompt_snapshot_json ON session_turns
                            BEGIN SELECT RAISE(ABORT, 'Input snapshot unavailable'); END`
                            : `CREATE TEMP TRIGGER input_handoff_failure
                            BEFORE DELETE ON session_pending_messages
                            BEGIN SELECT RAISE(ABORT, 'Pending removal unavailable'); END`
                    );
                }
            });

            await expect(runtime.run()).rejects.toBeInstanceOf(Error);

            expect(state.pending).toEqual([message]);
            expect(state.claimed.size).toBe(0);
            expect(state.issues).toContainEqual(
                expect.objectContaining({ phase: 'user_message_delivery' })
            );
            expect(state.events.some((event) => event.type === 'user_messages_delivered')).toBe(
                false
            );
            expect(
                httpFetch.mock.calls.every(([, init]) => !init.body.includes(message.prompt))
            ).toBe(true);
            expect(
                database
                    .prepare('SELECT id FROM message_parts WHERE content = ?')
                    .all(message.prompt)
            ).toEqual([]);
            expect(
                JSON.stringify(
                    database.prepare('SELECT prompt_snapshot_json FROM session_turns').all()
                )
            ).not.toContain(message.prompt);
            const restored = await new PendingMessagePersistence().load(state.sessionId!);
            expect(restored).toEqual([
                expect.objectContaining({
                    id: message.id,
                    prompt: message.prompt,
                    inputSnapshot: message.inputSnapshot,
                }),
            ]);
            expect(
                (await loadSessionHistory(state.sessionId!)).filter(
                    (entry) => entry.role === 'user'
                )
            ).toHaveLength(1);

            if (failure === 'transaction commit') routeQueriesTo(database);
            else database.exec('DROP TRIGGER input_handoff_failure');
            httpFetch.mockReset();
            httpFetch
                .mockResolvedValueOnce(response(true))
                .mockImplementation(async () => response());
            const recovered = durablePriorityRun(
                restored.map((pending) => ({ ...pending, delivery: 'priority' })),
                undefined,
                state.sessionId!
            );
            await expect(recovered.runtime.run()).resolves.toMatchObject({
                response: 'Three concise points.',
            });

            const history = await loadSessionHistory(state.sessionId!);
            expect(
                history.filter((entry) => entry.role === 'user' && entry.content === message.prompt)
            ).toEqual([expect.objectContaining({ inputSnapshot: message.inputSnapshot })]);
            await expect(new PendingMessagePersistence().load(state.sessionId!)).resolves.toEqual(
                []
            );
            expect(
                httpFetch.mock.calls.filter(([, init]) => init.body.includes(message.prompt))
            ).toHaveLength(1);
        }
    );

    it.each(['older snapshot', 'removed original input', 'one damaged inserted input'] as const)(
        'user reloads the remaining committed inputs with %s without losing unrelated metadata',
        async (context) => {
            const messages = [
                priorityMessage('first-input', 'First inserted input'),
                priorityMessage('second-input', 'Second inserted input'),
            ];
            for (const message of messages) {
                message.inputSnapshot = {
                    text: message.prompt,
                    attachments: [],
                    skills: [{ name: 'summary', path: skillFile().path }],
                    excludeFromHistory: true,
                };
            }
            const initialInput: InputHistorySnapshot = {
                text: 'Continue the active answer',
                attachments: [],
                skills: [{ name: 'widget', path: widgetSkillFile().path }],
                excludeFromHistory: true,
            };
            const { runtime, state } = durablePriorityRun(
                messages,
                undefined,
                undefined,
                initialInput
            );
            await runtime.run();

            if (context === 'older snapshot') {
                database.exec(
                    "UPDATE session_turns SET prompt_snapshot_json = json_remove(prompt_snapshot_json, '$.inputSnapshot', '$.messageInputSnapshots')"
                );
            } else if (context === 'removed original input') {
                database.exec(
                    'DELETE FROM messages WHERE id = (SELECT prompt_message_id FROM session_turns)'
                );
            } else {
                const messageRow = database
                    .prepare(
                        `SELECT messages.id FROM messages
                    JOIN message_parts ON message_parts.message_id = messages.id
                    WHERE messages.role = 'user' AND message_parts.content = ?`
                    )
                    .get(messages[0]!.prompt) as { id: number };
                database
                    .prepare(
                        'UPDATE session_turns SET prompt_snapshot_json = json_set(prompt_snapshot_json, ?, json(?))'
                    )
                    .run(`$.messageInputSnapshots."${messageRow.id}"`, '{"skills":"invalid"}');
            }

            const history = (await loadSessionHistory(state.sessionId!)).filter(
                (message) => message.role === 'user'
            );
            if (context === 'older snapshot') {
                expect(history.map((message) => message.inputSnapshot)).toEqual([
                    { text: initialInput.text, attachments: [], skills: initialInput.skills },
                    ...messages.map((message) => ({ text: message.prompt, attachments: [] })),
                ]);
            } else if (context === 'removed original input') {
                expect(history.map((message) => message.inputSnapshot)).toEqual(
                    messages.map((message) => message.inputSnapshot)
                );
            } else {
                expect(history.map((message) => message.inputSnapshot)).toEqual([
                    initialInput,
                    { text: messages[0]!.prompt, attachments: [] },
                    messages[1]!.inputSnapshot,
                ]);
            }
        }
    );
});

describe('given a skill is activated during a conversation that needs a retry', () => {
    it('user activates a widget skill then creates a widget and retains both completed exchanges as verifiable compaction sources', async () => {
        const widgetPath = '/app/skills/.system/widget/SKILL.md';
        const checkpoints: RuntimeTurnEvent[] = [];
        let step = 0;
        httpFetch.mockImplementation(async () => {
            step++;
            if (step === 1)
                return widgetResponse(
                    'builtin__activate_skill',
                    { path: widgetPath },
                    'read-widget'
                );
            if (step === 2) {
                return widgetResponse(
                    'builtin__show_widget',
                    {
                        is_read_widget_skill: true,
                        widget_code: '<section>Chart</section>',
                        widgetId: 'chart',
                    },
                    'create-widget'
                );
            }
            return response();
        });
        const result = await new AiConversationRuntime(new AiRequestExecutor(), {
            prompt: 'Draw a chart',
            taskId: 'widget-compaction-sources',
            onTurnEvent: (event) => {
                if (event.type === 'checkpoint_committed') checkpoints.push(event);
            },
        }).run();
        expect(result.response).toBe('Three concise points.');
        const checkpoint = checkpoints[checkpoints.length - 1];
        expect(checkpoint?.type).toBe('checkpoint_committed');
        if (checkpoint?.type !== 'checkpoint_committed') throw new Error('Expected checkpoint');
        const results = checkpoint.checkpoint.messages.filter((message) => message.role === 'tool');
        expect(results.map((message) => message.tool_call_id)).toEqual([
            'read-widget',
            'create-widget',
        ]);
        for (const message of results) {
            expect(message.contextSource).toEqual({
                id: expect.any(Number),
                fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
            });
        }
    });

    it.each(['shared', 'app'] as const)(
        'user asks the model to read an enabled %s skill and receives a response without approval events',
        async (scope) => {
            const file = skillFile('summary', false, scope);
            installSkillCommands([{ ...file, content: `${file.frontmatter}${privateMarker}` }]);
            httpFetch.mockResolvedValueOnce(response(true)).mockResolvedValueOnce(response());
            const requestToolApproval = vi.fn(async () => false);
            const chunks: AiStreamChunk[] = [];
            const result = await new AiConversationRuntime(new AiRequestExecutor(), {
                prompt: 'Summarize',
                requestToolApproval,
                onChunk: (chunk) => chunks.push(chunk),
            }).run();
            expect(result.response).toBe('Three concise points.');
            expect(requestToolApproval).not.toHaveBeenCalled();
            expect(chunks.some((chunk) => chunk.toolEvent?.type === 'approval_required')).toBe(
                false
            );
            expect(getTauriInvokeCalls('agent_skills_read_enabled_user_file')).toHaveLength(1);
            expect(httpFetch.mock.calls[1]![1].body).toContain(privateMarker);
            expect(JSON.stringify(chunks)).not.toContain(privateMarker);
        }
    );

    it.each([
        ['omits', {}],
        ['sets false', { is_read_widget_skill: false }],
        ['uses a string', { is_read_widget_skill: 'true' }],
        ['uses a number', { is_read_widget_skill: 1 }],
        ['uses the legacy key', { skill_key: 'legacy' }],
    ])(
        'user sees no widget preview or mutation when the model %s acknowledgement',
        async (_label, acknowledgement) => {
            httpFetch
                .mockResolvedValueOnce(
                    widgetResponse('builtin__show_widget', {
                        ...acknowledgement,
                        widget_code: '<section>Unauthorized preview</section>',
                    })
                )
                .mockResolvedValueOnce(response());
            const chunks: AiStreamChunk[] = [];
            await new AiConversationRuntime(new AiRequestExecutor(), {
                prompt: 'Draw a chart',
                onChunk: (chunk) => chunks.push(chunk),
            }).run();
            expect(chunks.flatMap((chunk) => chunk.toolCallDeltas ?? [])).toEqual([]);
            expect(chunks.flatMap((chunk) => chunk.toolCalls ?? [])).toEqual([]);
            expect(chunks.some((chunk) => chunk.toolEvent?.type === 'widget_upsert')).toBe(false);
        }
    );

    it.each([false, true])(
        'user can create and retry an acknowledged widget when explicit selection is %s',
        async (selected) => {
            const widgetPath = '/app/skills/.system/widget/SKILL.md';
            const requests: string[] = [];
            const chunks: AiStreamChunk[] = [];
            const events: RuntimeTurnEvent[] = [];
            let toolCallObserved = false;
            let step = selected ? 1 : 0;
            httpFetch.mockImplementation(async (_url, init) => {
                requests.push(init.body);
                const current = step++;
                if (current === 0)
                    return widgetResponse(
                        'builtin__activate_skill',
                        { path: widgetPath },
                        'read-widget'
                    );
                if (current === 2)
                    return new Response('{"error":{"message":"temporarily unavailable"}}', {
                        status: 503,
                    });
                if (current === 1 || current === 3)
                    return widgetResponse(
                        'builtin__show_widget',
                        {
                            is_read_widget_skill: true,
                            widget_code: `<section>Chart ${current}</section>`,
                            widgetId: 'chart',
                        },
                        `widget-${current}`
                    );
                return response();
            });
            const result = await new AiConversationRuntime(new AiRequestExecutor(), {
                prompt: 'Draw a chart',
                taskId: 'widget-privacy',
                inputSnapshot: {
                    text: 'Draw a chart',
                    attachments: [],
                    skills: selected ? [{ name: 'widget', path: widgetPath }] : [],
                },
                requestToolApproval: async () => true,
                onChunk: (chunk) => {
                    chunks.push(chunk);
                    toolCallObserved ||= Boolean(chunk.toolCalls?.length);
                },
                onTurnEvent: (event) => events.push(event),
            }).run();
            expect(result.response).toBe('Three concise points.');
            expect(toolCallObserved).toBe(true);
            expect(
                chunks.filter(
                    (chunk) =>
                        chunk.toolEvent?.type === 'widget_upsert' &&
                        chunk.toolEvent.phase === 'ready'
                )
            ).toHaveLength(2);
            expect(events.some((event) => event.type === 'retry_scheduled')).toBe(true);
            expect(requests[requests.length - 1]).toContain('is_read_widget_skill');
            expect(JSON.stringify(chunks)).toContain('is_read_widget_skill');
            expect(JSON.stringify(events)).toContain('is_read_widget_skill');
            const storedCalls = database
                .prepare(
                    "SELECT data FROM message_parts WHERE type = 'tool_call' AND tool_call_id LIKE 'widget-%'"
                )
                .all() as Array<{ data: string }>;
            expect(storedCalls).toHaveLength(2);
            for (const { data } of storedCalls) {
                expect(JSON.parse(data)).toMatchObject({
                    toolCallId: expect.stringMatching(/^widget-/),
                    input: expect.stringContaining('"is_read_widget_skill":true'),
                });
            }
            await flushObservability();
            expect(JSON.stringify(getTauriInvokeCalls('obs_ingest'))).not.toContain(
                'is_read_widget_skill'
            );

            httpFetch.mockReset();
            httpFetch
                .mockResolvedValueOnce(
                    widgetResponse('builtin__show_widget', {
                        is_read_widget_skill: false,
                        widget_code: '<section>Rejected acknowledgement</section>',
                    })
                )
                .mockResolvedValueOnce(response());
            const nextChunks: AiStreamChunk[] = [];
            await new AiConversationRuntime(new AiRequestExecutor(), {
                prompt: 'Draw another',
                sessionId: result.turn!.sessionId!,
                onChunk: (chunk) => nextChunks.push(chunk),
            }).run();
            expect(nextChunks.some((chunk) => chunk.toolEvent?.type === 'widget_upsert')).toBe(
                false
            );
            expect(nextChunks.flatMap((chunk) => chunk.toolCallDeltas ?? [])).toEqual([]);
        }
    );

    it('user reaches the skill limit and retains the rejected call as a verifiable history entry', async () => {
        setLocale('en-US');
        let calls = 0;
        let lastRequest = '';
        const checkpoints: RuntimeTurnEvent[] = [];
        httpFetch.mockImplementation(async (_url, init) => {
            calls++;
            lastRequest = init.body;
            return calls <= 17 ? response(true, `skill-${calls}`) : response();
        });
        const result = await new AiConversationRuntime(new AiRequestExecutor(), {
            prompt: 'Summarize',
            taskId: 'skill-limit-history',
            onTurnEvent: (event) => {
                if (event.type === 'checkpoint_committed') checkpoints.push(event);
            },
            requestToolApproval: async () => true,
        }).run();
        expect(result.response).toBe('Three concise points.');
        expect(lastRequest.split(privateMarker).length - 1).toBe(16);
        expect(lastRequest).toContain('Skill context limit reached');
        const stored = database
            .prepare("SELECT data FROM message_parts WHERE type = 'tool_call' AND tool_call_id = ?")
            .get('skill-17') as { data: string } | undefined;
        expect(stored).toBeDefined();
        expect(JSON.parse(stored!.data)).toMatchObject({
            toolCallId: 'skill-17',
            status: 'error',
            output: expect.stringContaining('Skill context limit reached'),
        });
        const checkpoint = checkpoints[checkpoints.length - 1];
        if (checkpoint?.type !== 'checkpoint_committed') throw new Error('Expected checkpoint');
        const rejected = checkpoint.checkpoint.messages.filter(
            (message) =>
                message.tool_call_id === 'skill-17' ||
                message.tool_calls?.some((call) => call.id === 'skill-17')
        );
        expect(rejected).toHaveLength(2);
        for (const message of rejected) {
            expect(message.contextSource).toEqual({
                id: expect.any(Number),
                fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
            });
        }
    });

    it.each(['disabled', 'failed'] as const)(
        'user keeps the activation limit across a retry after %s reads and gets a fresh limit next turn',
        async (outcome) => {
            setLocale('en-US');
            if (outcome === 'disabled') installSkillCommands([skillFile('summary', true)]);
            if (outcome === 'failed') {
                mockTauriCommand('agent_skills_read_enabled_user_file', () => {
                    throw new Error('Skill file unavailable');
                });
            }
            const approvals: string[] = [];
            const executor = new AiRequestExecutor();
            let calls = 0;
            let lastRequest = '';
            httpFetch.mockImplementation(async (_url, init) => {
                calls++;
                lastRequest = init.body;
                if (calls <= 16 || calls === 18) return response(true, `skill-${calls}`);
                if (calls === 17) {
                    return new Response('{"error":{"message":"temporarily unavailable"}}', {
                        status: 503,
                    });
                }
                return response();
            });
            const requestToolApproval = async ({ callId }: { callId: string }) => {
                approvals.push(callId);
                return false;
            };

            const first = await new AiConversationRuntime(executor, {
                prompt: 'Summarize',
                requestToolApproval,
            }).run();

            expect(first.response).toBe('Three concise points.');
            expect(approvals).toEqual([]);
            expect(getTauriInvokeCalls('agent_skills_read_enabled_user_file')).toHaveLength(
                outcome === 'failed' ? 16 : 0
            );
            expect(lastRequest).toContain('Skill context limit reached');
            expect(lastRequest).not.toContain(privateMarker);

            installSkillCommands();
            httpFetch.mockReset();
            httpFetch
                .mockResolvedValueOnce(response(true, 'next-turn'))
                .mockResolvedValueOnce(response());
            const next = await new AiConversationRuntime(executor, {
                prompt: 'Try the skill again',
                sessionId: first.turn!.sessionId!,
                requestToolApproval: async (request) => {
                    approvals.push(request.callId);
                    return true;
                },
            }).run();

            expect(next.response).toBe('Three concise points.');
            expect(approvals).toEqual([]);
            expect(getTauriInvokeCalls('agent_skills_read_enabled_user_file')).toHaveLength(
                outcome === 'failed' ? 17 : 1
            );
        }
    );

    it('user can follow a skill-only turn with an Anthropic request after history is reloaded', async () => {
        httpFetch.mockResolvedValueOnce(response());
        const first = await new AiConversationRuntime(new AiRequestExecutor(), {
            prompt: '',
            inputSnapshot: {
                text: '',
                attachments: [],
                skills: [{ name: 'summary', path: skillFile().path }],
            },
        }).run();
        expect(first.turn?.sessionId).toBeTypeOf('number');
        database.exec("UPDATE providers SET driver = 'anthropic';");
        let sent:
            | { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }
            | undefined;
        httpFetch.mockImplementationOnce(async (_url, init) => {
            sent = JSON.parse(init.body);
            const events = [
                {
                    type: 'message_start',
                    message: {
                        id: 'answer',
                        type: 'message',
                        role: 'assistant',
                        model: 'test-model',
                        content: [],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: 1, output_tokens: 0 },
                    },
                },
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '' },
                },
                {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: 'Follow-up answer.' },
                },
                { type: 'content_block_stop', index: 0 },
                {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn', stop_sequence: null },
                    usage: { output_tokens: 2 },
                },
                { type: 'message_stop' },
            ];
            return new Response(
                events
                    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                    .join(''),
                { headers: { 'content-type': 'text/event-stream' } }
            );
        });
        const followup = await new AiConversationRuntime(new AiRequestExecutor(), {
            prompt: 'Explain point two',
            sessionId: first.turn!.sessionId!,
        }).run();
        expect(followup.response).toBe('Follow-up answer.');
        const historicalUser = sent?.messages.find((message) => message.role === 'user');
        expect(historicalUser?.content.length).toBeGreaterThan(0);
        expect(
            historicalUser?.content.every(
                (part) => part.type !== 'text' || Boolean(part.text?.trim())
            )
        ).toBe(true);
        expect(JSON.stringify(sent)).not.toContain(privateMarker);
    });

    it.each([false, true])(
        'user keeps skill instructions private across events, checkpoints and history when explicit selection is %s',
        async (selected) => {
            const requests: unknown[] = [];
            const responses = [
                response(true),
                new Response('{"error":{"message":"temporarily unavailable"}}', { status: 503 }),
                response(),
            ];
            httpFetch.mockImplementation(async (_url, init) => {
                requests.push(JSON.parse(init.body));
                return responses.shift() ?? response();
            });
            const events: RuntimeTurnEvent[] = [];
            const chunks: unknown[] = [];
            const published: string[] = [];
            const snapshot: SessionTaskSnapshot = {
                taskId: 'privacy-task',
                sessionId: null,
                turnId: null,
                status: 'running',
                executionMode: 'foreground',
                sessionHistory: [],
                pendingUserMessages: [],
                pendingToolApproval: null,
                pendingApprovals: [],
                pendingUserQuestion: null,
                error: null,
                currentModel: null,
                startedAt: 0,
                updatedAt: 0,
                modelSwitchCount: 0,
            };
            const projection = new SessionTaskProjection(snapshot, () =>
                published.push(JSON.stringify(snapshot))
            );
            const inputSnapshot = {
                text: 'Summarize',
                attachments: [],
                skills: selected ? [{ name: 'summary', path: skillFile().path }] : [],
            };
            projection.bootstrap([], 'Summarize', [], inputSnapshot);
            const result = await new AiConversationRuntime(new AiRequestExecutor(), {
                prompt: 'Summarize',
                taskId: 'privacy-task',
                inputSnapshot,
                requestToolApproval: async () => true,
                onTurnEvent: (event) => {
                    events.push(event);
                    projection.syncTaskMetadata(event);
                },
                onChunk: (chunk) => {
                    chunks.push(chunk);
                    projection.handleChunk(chunk);
                },
            }).run();
            expect(result.response).toBe('Three concise points.');
            expect(events.map((event) => event.type)).toEqual(
                expect.arrayContaining([
                    'prompt_snapshot_ready',
                    'checkpoint_committed',
                    'retry_scheduled',
                    'task_completed',
                ])
            );
            expect(requests).toHaveLength(3);
            expect(JSON.stringify(requests[0]).includes(privateMarker)).toBe(selected);
            expect(JSON.stringify(requests[1])).toContain(privateMarker);
            expect(JSON.stringify(requests[2])).toContain(privateMarker);
            expect(JSON.stringify(events)).not.toContain(privateMarker);
            expect(JSON.stringify(chunks)).not.toContain(privateMarker);
            expect(published.join('\n')).not.toContain(privateMarker);
            for (const table of [
                'session_turns',
                'session_turn_attempts',
                'messages',
                'message_parts',
            ]) {
                expect(
                    JSON.stringify(database.prepare(`SELECT * FROM ${table}`).all())
                ).not.toContain(privateMarker);
            }
            await flushObservability();
            const logs = getTauriInvokeCalls('obs_ingest');
            expect(logs.length).toBeGreaterThan(0);
            expect(JSON.stringify(logs)).not.toContain(privateMarker);
        }
    );
});
