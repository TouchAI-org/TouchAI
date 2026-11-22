import { setImmediate } from 'node:timers/promises';

import { listen } from '@tauri-apps/api/event';
import { sendNotification } from '@tauri-apps/plugin-notification';
import {
    createAgentWindowFixture,
    network,
    response,
    streamingResponse,
} from '@tests/utils/agentWindow';
import { deferred } from '@tests/utils/productAnalytics';
import { installSkillCommands, skillFile } from '@tests/utils/skills';
import { mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    InputHistorySnapshot,
    PendingUserMessageInput,
    TaskViewSnapshot,
} from '@/app/api/agent/contracts';
import { initializeAgentWindow } from '@/app/bootstrap/agent';
import { createPendingMessagePersistence } from '@/app/workflows/agent/pending';
import { t } from '@/i18n';

vi.mock('@tauri-apps/plugin-notification', () => ({
    sendNotification: vi.fn(),
    isPermissionGranted: async () => true,
    requestPermission: async () => 'granted',
}));
beforeEach(() => vi.mocked(sendNotification).mockClear());

const owned: Array<ReturnType<typeof createAgentWindowFixture>['window']> = [];
afterEach(async () => {
    for (const window of owned.splice(0)) await window.dispose();
});
const marker = 'PRIVATE_STEER_SKILL_BODY';

/**
 * An attachment row already has its cache copy on disk: persistence may reuse it as-is.
 * Tests that need the copy gone override the file commands themselves.
 */
function installAttachmentCacheCommands() {
    mockTauriCommand('get_app_directory_path', '/test/cache');
    mockTauriCommand('plugin:path|join', (payload: unknown) =>
        (payload as { paths: string[] }).paths.join('/')
    );
    mockTauriCommand('plugin:fs|mkdir', undefined);
    mockTauriCommand('plugin:fs|exists', true);
}

async function running(
    options: Parameters<typeof createAgentWindowFixture>[2] = {},
    configure?: (fixture: ReturnType<typeof createAgentWindowFixture>) => void,
    prompt = 'Start',
    inputSnapshot?: InputHistorySnapshot
) {
    const fixture = createAgentWindowFixture('main', undefined, options);
    owned.push(fixture.window);
    configure?.(fixture);
    const stream = streamingResponse();
    network.replies.push(stream.response, response('After the steer'));
    const started = await fixture.window.api.startTask({ prompt, inputSnapshot });
    await vi.waitFor(() => expect(network.requests).toHaveLength(1));
    const snapshot = fixture.window.api.getTaskSnapshot(started.taskId)!;
    return { ...fixture, api: fixture.window.api, stream, started, sessionId: snapshot.sessionId! };
}

async function steer(
    fixture: Awaited<ReturnType<typeof running>>,
    value: PendingUserMessageInput = { prompt: 'Change direction' }
) {
    fixture.stream.delta({ content: 'Interrupted' });
    await vi.waitFor(() =>
        expect(
            fixture.api
                .getTaskSnapshot(fixture.started.taskId)
                ?.sessionHistory.some((message) => message.content.includes('Interrupted'))
        ).toBe(true)
    );
    const message = fixture.api.enqueueTaskUserMessage(fixture.started.taskId, value, 'queue')!;
    expect(message).not.toBeNull();
    expect(fixture.api.promoteTaskUserMessage(fixture.started.taskId, message.id)).toBe(true);
    fixture.stream.delta({ content: ' answer' });
    fixture.stream.finish();
    return message;
}

function userInputs() {
    return (network.requests.at(-1)?.messages as Array<{ role: string; content: unknown }>).filter(
        (message) => message.role === 'user'
    );
}

function completeInput(text: string): InputHistorySnapshot {
    const file = skillFile();
    return {
        text,
        attachments: [],
        skills: [{ name: file.name, path: file.path }],
        excludeFromHistory: true,
        editorDoc: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        },
    };
}

async function persistedQueue(prompts: string[]) {
    const fixture = createAgentWindowFixture();
    owned.push(fixture.window);
    await fixture.window.ready;
    fixture.database.exec(
        "INSERT INTO sessions (id, session_id, title, model, provider_id) VALUES (1, 'queue-recovery', 'Queue recovery', 'fixture-model', 1)"
    );
    installSkillCommands();
    const store = createPendingMessagePersistence();
    for (const [index, prompt] of prompts.entries()) {
        store.enqueue(1, {
            id: `pending-${index}`,
            prompt,
            attachments: [],
            inputSnapshot: completeInput(prompt),
            delivery: 'queue',
            modelId: 'fixture-model',
            providerId: 1,
            createdAt: 1_790_000_000_000 + index * 1000,
        });
    }
    await store.flush(1);
    const restored = await fixture.window.api.restoreSessionQueue(1);
    return { ...fixture, api: fixture.window.api, restored, store };
}

async function watchFailure(
    api: ReturnType<typeof initializeAgentWindow>['api'],
    action?: () => void
) {
    const failed = deferred<TaskViewSnapshot>();
    const stop = await listen<{ taskId: string; status: string }>(
        'session:task:status-changed',
        ({ payload }) => {
            if (payload.status !== 'failed') return;
            const snapshot = api.getTaskSnapshot(payload.taskId)!;
            action?.();
            failed.resolve(snapshot);
        }
    );
    return { failed, stop };
}

describe('user queues and steers through the production bootstrap', () => {
    it('user steers after a long answer then context compaction preserves the interrupted answer and newest input', async () => {
        const fixture = await running(
            {},
            ({ database }) =>
                database.exec('UPDATE models SET context_limit = 64000, output_limit = 8192'),
            'Background context. '.repeat(2100)
        );
        const longText = 'Long output detail. '.repeat(3500);
        fixture.stream.delta({ content: longText });
        await vi.waitFor(() =>
            expect(
                fixture.api
                    .getTaskSnapshot(fixture.started.taskId)
                    ?.sessionHistory.some((message) => message.content === longText)
            ).toBe(true)
        );
        const pending = fixture.api.enqueueTaskUserMessage(
            fixture.started.taskId,
            { prompt: 'Change direction' },
            'queue'
        )!;
        fixture.api.promoteTaskUserMessage(fixture.started.taskId, pending.id);
        network.replies.length = 0;
        network.respondToGeneration = async () =>
            response(
                JSON.stringify(network.requests.at(-1)).includes('ONLY output the summary')
                    ? 'Goal: change direction. Preserve the completed long answer.'
                    : 'Final response'
            );
        fixture.stream.delta({ content: ' End.' });
        fixture.stream.finish();
        const result = await fixture.started.completion;
        expect(result.response).toBe(longText + ' End.Final response');
        expect(
            fixture.database
                .prepare("SELECT id FROM message_parts WHERE type = 'context_compaction'")
                .all()
        ).toHaveLength(1);
        const history = (await fixture.api.loadSession(fixture.sessionId)).history;
        expect(
            history
                .filter((message) => message.role === 'assistant')
                .map((message) => message.content)
        ).toEqual([longText + ' End.', 'Final response']);
        expect(userInputs().at(-1)).toMatchObject({ content: pending.prompt });
    });

    it.each(['delivered', 'rejected'] as const)(
        'user cancels during a steer that is %s then only the other queued inputs run',
        async (outcome) => {
            let fixture: Awaited<ReturnType<typeof running>> | undefined = undefined;
            let cancelled = false;
            fixture = await running({
                afterQuery: ({ sql }) => {
                    if (
                        outcome === 'rejected' &&
                        !cancelled &&
                        sql.startsWith('delete from "session_pending_messages"')
                    )
                        cancelled = fixture!.api.cancelTask(fixture!.started.taskId);
                },
                beforeCommit: () => {
                    if (
                        outcome === 'delivered' &&
                        !cancelled &&
                        fixture?.database
                            .prepare("SELECT id FROM message_parts WHERE content = 'Settled steer'")
                            .get()
                    )
                        cancelled = fixture.api.cancelTask(fixture.started.taskId);
                },
            });
            network.replies.push(response('Last queued answer'));
            fixture.api.enqueueTaskUserMessage(
                fixture.started.taskId,
                { prompt: 'Waiting one' },
                'queue'
            );
            fixture.api.enqueueTaskUserMessage(
                fixture.started.taskId,
                { prompt: 'Waiting two' },
                'queue'
            );
            const input: PendingUserMessageInput = { prompt: 'Settled steer' };
            if (outcome === 'rejected') {
                const file = skillFile();
                installSkillCommands();
                input.inputSnapshot = {
                    text: input.prompt,
                    attachments: [],
                    skills: [{ name: file.name, path: file.path }],
                };
                mockTauriCommand('agent_skills_read_enabled_user_file', () => {
                    throw new Error('Selected skill unavailable');
                });
            }
            await steer(fixture, input);
            await expect(fixture.started.completion).rejects.toMatchObject({
                code: 'REQUEST_CANCELLED',
            });
            await vi.waitFor(() => expect(network.requests).toHaveLength(3));
            await vi.waitFor(() =>
                expect(fixture.api.getSessionStatus(fixture.sessionId)).toBeNull()
            );
            expect(cancelled).toBe(true);
            expect(
                network.requests.map(
                    (request) =>
                        (request.messages as Array<{ role: string; content: string }>)
                            .filter((message) => message.role === 'user')
                            .at(-1)?.content
                )
            ).toEqual(['Start', 'Waiting one', 'Waiting two']);
            expect(
                fixture.database
                    .prepare("SELECT id FROM message_parts WHERE content = 'Settled steer'")
                    .all()
            ).toHaveLength(outcome === 'delivered' ? 1 : 0);
            await expect(
                createPendingMessagePersistence().load(fixture.sessionId)
            ).resolves.toEqual([]);
        }
    );
    it.each(['selected skill', 'attachment'] as const)(
        'user closes the owner during %s preparation then the pending input remains durable',
        async (resource) => {
            const fixture = await running({}, ({ database }) =>
                database.exec('UPDATE models SET attachment = 1')
            );
            const entered = deferred<void>();
            const release = deferred<never>();
            const input: PendingUserMessageInput = { prompt: 'Keep this pending input' };
            const block = () => {
                entered.resolve();
                return release.promise;
            };
            if (resource === 'selected skill') {
                const file = skillFile();
                installSkillCommands();
                input.inputSnapshot = {
                    text: input.prompt,
                    attachments: [],
                    skills: [{ name: file.name, path: file.path }],
                };
                mockTauriCommand('agent_skills_read_enabled_user_file', block);
            } else {
                const hash = 'c'.repeat(64);
                fixture.database
                    .prepare(
                        "INSERT INTO attachments (id, hash, type, original_name, origin_path, mime_type) VALUES (1, ?, 'file', 'pending.txt', '/pending.txt', 'text/plain')"
                    )
                    .run(hash);
                input.attachments = [
                    {
                        id: 'pending-attachment',
                        attachmentId: 1,
                        hash,
                        type: 'file',
                        name: 'pending.txt',
                        path: '/pending.txt',
                        originPath: '/pending.txt',
                        mimeType: 'text/plain',
                    },
                ];
                installAttachmentCacheCommands();
                mockTauriCommand('plugin:fs|open', block);
            }
            const pending = await steer(fixture, input);
            await entered.promise;
            const completion = fixture.started.completion.catch((error: unknown) => error);
            const closing = fixture.window.dispose();
            release.reject(new DOMException('Owner closed', 'AbortError'));
            await closing;
            expect(await completion).toMatchObject({ code: 'REQUEST_CANCELLED' });
            expect(network.requests).toHaveLength(1);
            await expect(
                createPendingMessagePersistence().load(fixture.sessionId)
            ).resolves.toMatchObject([{ id: pending.id, prompt: input.prompt }]);
            expect(
                fixture.database
                    .prepare('SELECT id FROM message_parts WHERE content = ?')
                    .all(input.prompt)
            ).toEqual([]);
            expect(sendNotification).not.toHaveBeenCalledWith(
                expect.objectContaining({ title: t('agent.priorityMessage.removedTitle') })
            );
        }
    );
    it('user clears pending work while a selected skill loads then the steer never reaches history or transport', async () => {
        const fixture = await running();
        const file = skillFile();
        installSkillCommands();
        const entered = deferred<void>();
        const release = deferred<string>();
        mockTauriCommand('agent_skills_read_enabled_user_file', () => {
            entered.resolve();
            return release.promise;
        });
        await steer(fixture, {
            prompt: 'Cleared steer',
            inputSnapshot: {
                text: 'Cleared steer',
                attachments: [],
                skills: [{ name: file.name, path: file.path }],
            },
        });
        await entered.promise;
        expect(fixture.api.clearTaskUserMessages(fixture.started.taskId)).toBe(true);
        release.resolve(file.content);
        await fixture.started.completion;
        expect(network.requests).toHaveLength(1);
        expect(
            (await fixture.api.loadSession(fixture.sessionId)).history.some(
                (message) => message.content === 'Cleared steer'
            )
        ).toBe(false);
        await expect(createPendingMessagePersistence().load(fixture.sessionId)).resolves.toEqual(
            []
        );
    });
    it('user steers during an answer then reloads both complete assistant segments in order', async () => {
        const blocked = deferred<void>();
        const release = deferred<void>();
        let database: ReturnType<typeof createAgentWindowFixture>['database'] | undefined =
            undefined;
        let delayed = false;
        const fixture = await running({
            beforeCommit: async () => {
                if (
                    !delayed &&
                    database?.prepare("SELECT id FROM messages WHERE role = 'assistant'").get()
                ) {
                    delayed = true;
                    blocked.resolve();
                    await release.promise;
                }
            },
        });
        database = fixture.database;
        const pending = await steer(fixture);
        await blocked.promise;
        try {
            expect(
                fixture.api.getTaskSnapshot(fixture.started.taskId)?.pendingUserMessages
            ).toHaveLength(1);
        } finally {
            release.resolve();
        }
        await fixture.started.completion;
        const loaded = await fixture.api.loadSession(fixture.sessionId);
        expect(loaded.history.map(({ role, content }) => ({ role, content }))).toEqual([
            { role: 'user', content: 'Start' },
            { role: 'assistant', content: 'Interrupted answer' },
            { role: 'user', content: pending.prompt },
            { role: 'assistant', content: 'After the steer' },
        ]);
        expect(fixture.api.getTaskSnapshot(fixture.started.taskId)?.pendingUserMessages).toEqual(
            []
        );
    });

    it('user queues behind a question then the inserted input follows the completed tool exchange', async () => {
        const fixture = createAgentWindowFixture();
        owned.push(fixture.window);
        network.replies.push(response('', true), response('After the tool'));
        const started = await fixture.window.api.startTask({ prompt: 'Ask me' });
        const question = await vi.waitFor(() => {
            const value = fixture.window.api.getTaskSnapshot(started.taskId)?.pendingUserQuestion;
            expect(value).toBeTruthy();
            return value!;
        });
        const pending = fixture.window.api.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'Priority instruction' },
            'priority'
        )!;
        expect(network.requests).toHaveLength(1);
        expect(
            fixture.window.api.settleTaskUserQuestion(
                started.taskId,
                question.callId,
                [{ questionIndex: 0, selectedLabels: ['Left'], skipped: false }],
                question.decisionId
            )
        ).toBe(true);
        await started.completion;
        const request = network.requests[1]!.messages as Array<{ role: string; content: unknown }>;
        expect(request.at(-1)).toMatchObject({ role: 'user', content: pending.prompt });
        expect(request.at(-2)?.role).toBe('tool');
        expect(fixture.window.api.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([]);
    });

    it('user inserts selected skills then transport includes the private body and reload restores input metadata only', async () => {
        const fixture = await running();
        const file = skillFile();
        installSkillCommands([{ ...file, content: file.frontmatter + marker }]);
        const inputSnapshot: InputHistorySnapshot = {
            text: 'Tagged input',
            attachments: [],
            skills: [{ name: file.name, path: file.path }],
            editorDoc: { type: 'doc', content: [] },
            excludeFromHistory: true,
        };
        await steer(fixture, { prompt: inputSnapshot.text, inputSnapshot });
        await fixture.started.completion;
        expect(JSON.stringify(userInputs().at(-1))).toContain(marker);
        const loaded = await fixture.api.loadSession(fixture.sessionId);
        expect(
            loaded.history.find((message) => message.content === inputSnapshot.text)?.inputSnapshot
        ).toEqual(inputSnapshot);
        expect(JSON.stringify(loaded)).not.toContain(marker);
        expect(JSON.stringify(fixture.api.getTaskSnapshot(fixture.started.taskId))).not.toContain(
            marker
        );
        for (const table of ['message_parts', 'session_turns', 'session_turn_attempts'])
            expect(
                JSON.stringify(fixture.database.prepare(`SELECT * FROM ${table}`).all())
            ).not.toContain(marker);
    });

    it.each(['history insert', 'pending flush', 'rejected deletion'] as const)(
        'user hits a %s failure while steering then keeps the input recoverable without sending it',
        async (failure) => {
            const fixture = await running();
            const file = skillFile();
            installSkillCommands([{ ...file, content: file.frontmatter + marker }]);
            if (failure === 'rejected deletion')
                mockTauriCommand('agent_skills_read_enabled_user_file', () => {
                    throw new Error('skill unavailable');
                });
            const trigger =
                failure === 'history insert'
                    ? "BEFORE INSERT ON message_parts WHEN NEW.type = 'text' AND NEW.content = 'Recoverable input'"
                    : failure === 'pending flush'
                      ? 'BEFORE INSERT ON session_pending_messages'
                      : 'BEFORE DELETE ON session_pending_messages';
            fixture.database.exec(
                `CREATE TEMP TRIGGER reject_delivery ${trigger} BEGIN SELECT RAISE(ABORT, 'fixture queue storage failure'); END;`
            );
            const pending = await steer(fixture, {
                prompt: 'Recoverable input',
                inputSnapshot: {
                    text: 'Recoverable input',
                    attachments: [],
                    skills: [{ name: file.name, path: file.path }],
                },
            });
            await expect(fixture.started.completion).rejects.toBeInstanceOf(Error);
            expect(network.requests).toHaveLength(1);
            expect(sendNotification).toHaveBeenCalledWith(
                expect.objectContaining({ body: t('agent.persistenceIssue.userMessageDelivery') })
            );
            expect(
                fixture.api.getTaskSnapshot(fixture.started.taskId)?.pendingUserMessages
            ).toEqual([expect.objectContaining({ id: pending.id, delivery: 'queue' })]);
            expect(
                fixture.database
                    .prepare(
                        "SELECT content FROM message_parts WHERE content = 'Recoverable input'"
                    )
                    .all()
            ).toEqual([]);
            fixture.database.exec('DROP TRIGGER reject_delivery');
            installSkillCommands([{ ...file, content: file.frontmatter + marker }]);
            fixture.api.resumeSessionQueue(fixture.sessionId);
            await vi.waitFor(() => expect(network.requests).toHaveLength(2));
            await vi.waitFor(() =>
                expect(fixture.api.getSessionStatus(fixture.sessionId)).toBeNull()
            );
            expect(JSON.stringify(userInputs().at(-1))).toContain('Recoverable input');
            expect(JSON.stringify(network.requests.at(-1))).toContain(marker);
            await expect(
                createPendingMessagePersistence().load(fixture.sessionId)
            ).resolves.toEqual([]);
        }
    );

    it.each(['unsupported image', 'unavailable skill', 'unreadable file'] as const)(
        'user steers with an %s then the rejected input is removed durably',
        async (reason) => {
            const fixture = await running({}, ({ database }) => {
                if (reason === 'unreadable file') database.exec('UPDATE models SET attachment = 1');
            });
            const input: PendingUserMessageInput = { prompt: 'Rejected input' };
            if (reason === 'unavailable skill') {
                const file = skillFile();
                installSkillCommands();
                input.inputSnapshot = {
                    text: input.prompt,
                    attachments: [],
                    skills: [{ name: file.name, path: file.path }],
                };
                mockTauriCommand('agent_skills_read_enabled_user_file', () => {
                    throw new Error('skill unavailable');
                });
            } else {
                const type = reason === 'unsupported image' ? 'image' : 'file';
                const hash = 'a'.repeat(64);
                fixture.database
                    .prepare(
                        `INSERT INTO attachments (id, hash, type, original_name, origin_path, mime_type) VALUES (1, ?, ?, 'fixture', '/fixture', ?)`
                    )
                    .run(hash, type, type === 'image' ? 'image/png' : 'text/plain');
                input.attachments = [
                    {
                        id: 'attachment',
                        attachmentId: 1,
                        hash,
                        type,
                        name: 'fixture',
                        path: '/fixture',
                        originPath: '/fixture',
                        mimeType: type === 'image' ? 'image/png' : 'text/plain',
                    },
                ];
                installAttachmentCacheCommands();
                if (reason === 'unreadable file')
                    mockTauriCommand('plugin:fs|open', () => {
                        throw new Error('attachment unavailable');
                    });
            }
            await steer(fixture, input);
            await fixture.started.completion;
            expect(network.requests).toHaveLength(1);
            expect(
                fixture.api.getTaskSnapshot(fixture.started.taskId)?.pendingUserMessages
            ).toEqual([]);
            await expect(
                createPendingMessagePersistence().load(fixture.sessionId)
            ).resolves.toEqual([]);
            expect(
                (await fixture.api.loadSession(fixture.sessionId)).history.some(
                    (message) => message.content === input.prompt
                )
            ).toBe(false);
            expect(sendNotification).toHaveBeenCalledWith(
                expect.objectContaining({ title: t('agent.priorityMessage.removedTitle') })
            );
        }
    );

    it('user queues a message whose start write fails then resumes it without duplicate delivery', async () => {
        const fixture = await running();
        fixture.database
            .exec(`CREATE TEMP TRIGGER reject_queued_start BEFORE INSERT ON message_parts
            WHEN NEW.content = 'Queued input' BEGIN SELECT RAISE(ABORT, 'queued start refused'); END;`);
        const pending = fixture.api.enqueueTaskUserMessage(
            fixture.started.taskId,
            { prompt: 'Queued input' },
            'queue'
        )!;
        fixture.stream.delta({ content: 'First answer' });
        fixture.stream.finish();
        await fixture.started.completion;
        await vi.waitFor(() => {
            expect(fixture.api.getSessionStatus(fixture.sessionId)).toBeNull();
            expect(
                fixture.database.prepare('SELECT id FROM session_pending_messages').all()
            ).toEqual([{ id: pending.id }]);
        });
        await vi.waitFor(() =>
            expect(sendNotification).toHaveBeenCalledWith(
                expect.objectContaining({ body: t('agent.persistenceIssue.queuedTurnStart') })
            )
        );
        expect(network.requests).toHaveLength(1);
        fixture.database.exec('DROP TRIGGER reject_queued_start');
        fixture.api.resumeSessionQueue(fixture.sessionId);
        await vi.waitFor(() => expect(network.requests).toHaveLength(2));
        await vi.waitFor(() => expect(fixture.api.getSessionStatus(fixture.sessionId)).toBeNull());
        expect(
            fixture.database
                .prepare("SELECT content FROM message_parts WHERE content = 'Queued input'")
                .all()
        ).toHaveLength(1);
        await expect(createPendingMessagePersistence().load(fixture.sessionId)).resolves.toEqual(
            []
        );
    });

    it('user queues a message that commits before the provider fails then that input is not requeued', async () => {
        const fixture = await running();
        network.replies.splice(
            0,
            network.replies.length,
            new Response('Unauthorized', { status: 401 })
        );
        fixture.api.enqueueTaskUserMessage(
            fixture.started.taskId,
            { prompt: 'Committed input' },
            'queue'
        );
        fixture.stream.delta({ content: 'First answer' });
        fixture.stream.finish();
        await fixture.started.completion;
        await vi.waitFor(() => expect(network.requests).toHaveLength(2));
        await vi.waitFor(() => expect(fixture.api.getSessionStatus(fixture.sessionId)).toBeNull());
        await expect(createPendingMessagePersistence().load(fixture.sessionId)).resolves.toEqual(
            []
        );
        expect(
            fixture.database
                .prepare("SELECT content FROM message_parts WHERE content = 'Committed input'")
                .all()
        ).toHaveLength(1);
    });

    it('user steers twice when the later insert fails then both inputs recover in order with their skills', async () => {
        const fixture = await running();
        const file = skillFile();
        installSkillCommands([{ ...file, content: file.frontmatter + marker }]);
        fixture.database.exec(`CREATE TEMP TRIGGER reject_second BEFORE INSERT ON message_parts
            WHEN NEW.content = 'Second steer' BEGIN SELECT RAISE(ABORT, 'second insertion refused'); END;`);
        const first = fixture.api.enqueueTaskUserMessage(
            fixture.started.taskId,
            {
                prompt: 'First steer',
                inputSnapshot: {
                    text: 'First steer',
                    attachments: [],
                    skills: [{ name: file.name, path: file.path }],
                },
            },
            'priority'
        )!;
        const second = await steer(fixture, { prompt: 'Second steer' });
        await expect(fixture.started.completion).rejects.toBeInstanceOf(Error);
        expect(network.requests).toHaveLength(1);
        const restored = await createPendingMessagePersistence().load(fixture.sessionId);
        expect(restored.map((message) => message.id)).toEqual([first.id, second.id]);
        expect(
            fixture.database
                .prepare(
                    "SELECT content FROM message_parts WHERE content IN ('First steer', 'Second steer')"
                )
                .all()
        ).toEqual([]);
        expect(
            JSON.parse(
                String(
                    fixture.database
                        .prepare('SELECT prompt_snapshot_json FROM session_turns')
                        .get()!.prompt_snapshot_json
                )
            )
        ).not.toHaveProperty('messageInputSnapshots');
        fixture.database.exec('DROP TRIGGER reject_second');
        network.replies.push(response('Second recovered answer'));
        fixture.api.resumeSessionQueue(fixture.sessionId);
        await vi.waitFor(() => expect(network.requests).toHaveLength(3));
        await vi.waitFor(() => expect(fixture.api.getSessionStatus(fixture.sessionId)).toBeNull());
        expect(
            fixture.database
                .prepare(
                    "SELECT content FROM message_parts WHERE content IN ('First steer', 'Second steer') ORDER BY id"
                )
                .all()
                .map((row) => row.content)
        ).toEqual(['First steer', 'Second steer']);
        expect(JSON.stringify(network.requests[1])).toContain(marker);
    });

    it.each([false, true])(
        'user retries an automatic queued start with an earlier parked edit set to %s then retains its position and complete input',
        async (parkEarlier) => {
            const fixture = await persistedQueue(
                parkEarlier
                    ? ['Parked input', 'Recover full input', 'Waiting input']
                    : ['Recover full input', 'Waiting input']
            );
            const selected = fixture.restored[parkEarlier ? 1 : 0]!;
            if (parkEarlier)
                fixture.api.setSessionUserMessageEditing(1, fixture.restored[0]!.id, true);
            const expected = fixture.restored.map((message, index) =>
                parkEarlier && index === 0 ? { ...message, editing: true } : message
            );
            fixture.database.exec(
                "CREATE TEMP TRIGGER reject_start BEFORE INSERT ON session_turn_attempts BEGIN SELECT RAISE(ABORT, 'fixture start failure'); END"
            );
            const observed = await watchFailure(fixture.api);
            try {
                fixture.api.resumeSessionQueue(1);
                const failed = await observed.failed.promise;
                expect(failed.pendingUserMessages).toEqual(expected);
                expect(
                    failed.sessionHistory.filter((message) => message.id === selected.id)
                ).toEqual([]);
                await expect(fixture.api.restoreSessionQueue(1)).resolves.toEqual(expected);
                await expect(createPendingMessagePersistence().load(1)).resolves.toEqual(
                    fixture.restored
                );
                expect(network.requests).toEqual([]);
                expect(fixture.database.prepare('SELECT id FROM messages').all()).toEqual([]);
                fixture.database.exec('DROP TRIGGER reject_start');
                network.replies.push(response('Recovered'), response('Following'));
                fixture.api.resumeSessionQueue(1);
                await vi.waitFor(() => expect(network.requests).toHaveLength(2));
                await vi.waitFor(() => expect(fixture.api.getSessionStatus(1)).toBeNull());
                expect(
                    network.requests.map(
                        (request) =>
                            (request.messages as Array<{ role: string; content: string }>)
                                .filter((message) => message.role === 'user')
                                .at(-1)?.content
                    )
                ).toEqual(['Recover full input', 'Waiting input']);
                const history = (await fixture.api.loadSession(1)).history;
                expect(history.filter((message) => message.content === selected.prompt)).toEqual([
                    expect.objectContaining({ inputSnapshot: selected.inputSnapshot }),
                ]);
                await expect(createPendingMessagePersistence().load(1)).resolves.toEqual(
                    parkEarlier ? [fixture.restored[0]] : []
                );
            } finally {
                observed.stop();
            }
        }
    );

    it('user reopens after a queued start fails then restores and delivers the complete input once', async () => {
        const fixture = await persistedQueue(['Reopen this input']);
        fixture.database.exec(
            "CREATE TEMP TRIGGER reject_start BEFORE INSERT ON session_turn_attempts BEGIN SELECT RAISE(ABORT, 'fixture start failure'); END"
        );
        const observed = await watchFailure(fixture.api);
        try {
            fixture.api.resumeSessionQueue(1);
            await observed.failed.promise;
            expect(network.requests).toEqual([]);
            fixture.database.exec('DROP TRIGGER reject_start');
            await fixture.window.dispose();
            const reopened = initializeAgentWindow();
            owned.push(reopened);
            await reopened.ready;
            await expect(reopened.api.restoreSessionQueue(1)).resolves.toEqual(fixture.restored);
            network.replies.push(response('Recovered'));
            reopened.api.resumeSessionQueue(1);
            await vi.waitFor(() => expect(network.requests).toHaveLength(1));
            await vi.waitFor(() => expect(reopened.api.getSessionStatus(1)).toBeNull());
            expect(
                (await reopened.api.loadSession(1)).history.filter(
                    (message) => message.role === 'user'
                )
            ).toEqual([
                expect.objectContaining({ inputSnapshot: fixture.restored[0]!.inputSnapshot }),
            ]);
            await expect(createPendingMessagePersistence().load(1)).resolves.toEqual([]);
        } finally {
            observed.stop();
        }
    });

    it('user clears pending work when a late queued start fails then neither failed nor waiting input returns', async () => {
        const fixture = await persistedQueue(['Clear failed input', 'Clear waiting input']);
        fixture.database.exec(
            "CREATE TEMP TRIGGER reject_start BEFORE INSERT ON session_turn_attempts BEGIN SELECT RAISE(ABORT, 'fixture start failure'); END"
        );
        let cleared = false;
        const observed = await watchFailure(fixture.api, () => {
            cleared = fixture.api.clearSessionUserMessages(1);
        });
        try {
            fixture.api.resumeSessionQueue(1);
            const failed = await observed.failed.promise;
            expect(cleared).toBe(true);
            expect(fixture.api.getTaskSnapshot(failed.taskId)?.pendingUserMessages).toEqual([]);
            expect(
                failed.sessionHistory.some((message) => message.id === fixture.restored[0]!.id)
            ).toBe(false);
            await vi.waitFor(async () =>
                expect(await createPendingMessagePersistence().load(1)).toEqual([])
            );
            fixture.database.exec('DROP TRIGGER reject_start');
            fixture.api.resumeSessionQueue(1);
            await setImmediate();
            await expect(fixture.api.restoreSessionQueue(1)).resolves.toEqual([]);
            expect(network.requests).toEqual([]);
        } finally {
            observed.stop();
        }
    });

    it('user inserts a skill with attachment parts then the skill precedes the intact file reference only in transport', async () => {
        const fixture = await running({}, ({ database }) =>
            database.exec('UPDATE models SET attachment = 1')
        );
        const file = skillFile();
        installSkillCommands([{ ...file, content: file.frontmatter + marker }]);
        const hash = 'b'.repeat(64);
        fixture.database
            .prepare(
                "INSERT INTO attachments (id, hash, type, original_name, origin_path, mime_type) VALUES (1, ?, 'file', 'reference.pdf', '/fixture.pdf', 'application/pdf')"
            )
            .run(hash);
        const attachments = [
            {
                id: 'file',
                attachmentId: 1,
                hash,
                type: 'file' as const,
                name: 'reference.pdf',
                path: '/fixture.pdf',
                originPath: '/fixture.pdf',
                mimeType: 'application/pdf',
            },
        ];
        installAttachmentCacheCommands();
        await steer(fixture, {
            prompt: 'Use the reference',
            attachments,
            inputSnapshot: {
                text: 'Use the reference',
                attachments,
                skills: [{ name: file.name, path: file.path }],
            },
        });
        await fixture.started.completion;
        const parts = userInputs().at(-1)?.content as Array<{ type: string; text?: string }>;
        expect(parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining(marker) });
        expect(parts[1]).toEqual({ type: 'text', text: 'Use the reference' });
        expect(JSON.stringify(parts.slice(2))).toContain('/fixture.pdf');
        const loaded = await fixture.api.loadSession(fixture.sessionId);
        expect(
            loaded.history.find((message) => message.content === 'Use the reference')?.attachments
        ).toEqual([expect.objectContaining({ hash, name: 'reference.pdf' })]);
        expect(JSON.stringify(loaded)).not.toContain(marker);
    });

    it('user reloads ordinary and inserted inputs then each keeps its own skills, editor content and history preference', async () => {
        const initial = completeInput('Start');
        const fixture = await running({}, () => installSkillCommands(), initial.text, initial);
        const inputs: PendingUserMessageInput[] = [
            { prompt: 'Complete input', inputSnapshot: completeInput('Complete input') },
            {
                prompt: 'Formatted input',
                inputSnapshot: {
                    text: 'Formatted input',
                    attachments: [],
                    editorDoc: {
                        type: 'doc',
                        content: [
                            {
                                type: 'paragraph',
                                content: [
                                    {
                                        type: 'text',
                                        text: 'Formatted input',
                                        marks: [{ type: 'bold' }],
                                    },
                                ],
                            },
                        ],
                    },
                },
            },
            {
                prompt: 'Excluded input',
                inputSnapshot: {
                    text: 'Excluded input',
                    attachments: [],
                    excludeFromHistory: true,
                },
            },
            { prompt: 'Plain input' },
            { prompt: '', inputSnapshot: { text: '', attachments: [], skills: initial.skills } },
        ];
        for (const input of inputs.slice(0, -1))
            fixture.api.enqueueTaskUserMessage(fixture.started.taskId, input, 'priority');
        await steer(fixture, inputs.at(-1));
        await fixture.started.completion;
        const loaded = await fixture.api.loadSession(fixture.sessionId);
        expect(
            loaded.history
                .filter((message) => message.role === 'user')
                .map((message) => message.inputSnapshot)
        ).toEqual([
            initial,
            ...inputs.map(
                (input) => input.inputSnapshot ?? { text: input.prompt, attachments: [] }
            ),
        ]);
        expect(fixture.database.prepare('SELECT id FROM session_turns').all()).toHaveLength(1);
        expect(fixture.database.prepare('SELECT id FROM session_turn_attempts').all()).toHaveLength(
            1
        );
        await expect(createPendingMessagePersistence().load(fixture.sessionId)).resolves.toEqual(
            []
        );
    });

    it.each(['snapshot write', 'pending removal', 'transaction commit'] as const)(
        'user encounters a %s failure then recovers complete input metadata without duplicate history',
        async (failure) => {
            let fixture: Awaited<ReturnType<typeof running>> | undefined = undefined;
            let failCommit = failure === 'transaction commit';
            fixture = await running({
                beforeCommit: () => {
                    if (
                        failCommit &&
                        fixture?.database
                            .prepare(
                                "SELECT id FROM message_parts WHERE content = 'Recover complete input'"
                            )
                            .get()
                    ) {
                        failCommit = false;
                        throw new Error('fixture commit failure');
                    }
                },
            });
            installSkillCommands();
            if (failure !== 'transaction commit')
                fixture.database.exec(
                    `CREATE TEMP TRIGGER reject_input ${failure === 'snapshot write' ? 'BEFORE UPDATE OF prompt_snapshot_json ON session_turns' : 'BEFORE DELETE ON session_pending_messages'} BEGIN SELECT RAISE(ABORT, 'fixture input failure'); END`
                );
            const inputSnapshot = completeInput('Recover complete input');
            const pending = await steer(fixture, { prompt: inputSnapshot.text, inputSnapshot });
            await expect(fixture.started.completion).rejects.toMatchObject({
                code: 'PERSISTENCE_FAILED',
            });
            expect(network.requests).toHaveLength(1);
            expect(
                fixture.database
                    .prepare(
                        "SELECT id FROM message_parts WHERE content = 'Recover complete input'"
                    )
                    .all()
            ).toEqual([]);
            expect(
                JSON.stringify(
                    fixture.database.prepare('SELECT prompt_snapshot_json FROM session_turns').all()
                )
            ).not.toContain(inputSnapshot.text);
            await expect(
                createPendingMessagePersistence().load(fixture.sessionId)
            ).resolves.toEqual([expect.objectContaining({ id: pending.id, inputSnapshot })]);
            if (failure !== 'transaction commit')
                fixture.database.exec('DROP TRIGGER reject_input');
            fixture.api.resumeSessionQueue(fixture.sessionId);
            await vi.waitFor(() => expect(network.requests).toHaveLength(2));
            await vi.waitFor(() =>
                expect(fixture.api.getSessionStatus(fixture.sessionId)).toBeNull()
            );
            expect(
                (await fixture.api.loadSession(fixture.sessionId)).history.filter(
                    (message) => message.content === inputSnapshot.text
                )
            ).toEqual([expect.objectContaining({ inputSnapshot })]);
            await expect(
                createPendingMessagePersistence().load(fixture.sessionId)
            ).resolves.toEqual([]);
        }
    );

    it.each(['older snapshot', 'removed original input', 'one damaged inserted input'] as const)(
        'user reloads with %s then unrelated committed input metadata survives',
        async (context) => {
            const initial = completeInput('Start');
            const fixture = await running({}, () => installSkillCommands(), initial.text, initial);
            const inputs = [
                completeInput('First inserted input'),
                completeInput('Second inserted input'),
            ];
            fixture.api.enqueueTaskUserMessage(
                fixture.started.taskId,
                { prompt: inputs[0]!.text, inputSnapshot: inputs[0] },
                'priority'
            );
            await steer(fixture, { prompt: inputs[1]!.text, inputSnapshot: inputs[1] });
            await fixture.started.completion;
            if (context === 'older snapshot')
                fixture.database.exec(
                    "UPDATE session_turns SET prompt_snapshot_json = json_remove(prompt_snapshot_json, '$.inputSnapshot', '$.messageInputSnapshots')"
                );
            else if (context === 'removed original input')
                fixture.database.exec(
                    'DELETE FROM messages WHERE id = (SELECT prompt_message_id FROM session_turns)'
                );
            else {
                const row = fixture.database
                    .prepare('SELECT message_id FROM message_parts WHERE content = ?')
                    .get(inputs[0]!.text)!;
                fixture.database
                    .prepare(
                        'UPDATE session_turns SET prompt_snapshot_json = json_set(prompt_snapshot_json, ?, json(?))'
                    )
                    .run(`$.messageInputSnapshots."${row.message_id}"`, '{"skills":"invalid"}');
            }
            const loaded = (await fixture.api.loadSession(fixture.sessionId)).history
                .filter((message) => message.role === 'user')
                .map((message) => message.inputSnapshot);
            expect(loaded).toEqual(
                context === 'older snapshot'
                    ? [
                          { text: initial.text, attachments: [], skills: initial.skills },
                          ...inputs.map((input) => ({ text: input.text, attachments: [] })),
                      ]
                    : context === 'removed original input'
                      ? inputs
                      : [initial, { text: inputs[0]!.text, attachments: [] }, inputs[1]]
            );
        }
    );
});
