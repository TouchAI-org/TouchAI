import { clearMocks, mockWindows } from '@tauri-apps/api/mocks';
import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { agentPresentation } from '@tests/utils/agentProjection';
import { createModels } from '@touchai/models';
import { OpenAICompatibleProviderAdapter } from '@touchai/models/providers/openai-compatible';
import { afterEach, describe, expect, it } from 'vitest';

import { assembleAgentHost } from '@/app/composition/main';
import { createAgentHistoryQueries } from '@/app/workflows/agent/history';
import { createMainAgentWorkflow } from '@/app/workflows/agent/host';
import { createTaskModelBindings } from '@/app/workflows/agent/modelBindings';
import { createWidgetMarkupInspector } from '@/components/widgets/inspection';
import { t, tt } from '@/i18n';
import { createModelSelection, createModelsModule, readConnectionState } from '@/modules/models';
import {
    createAskUserTools,
    createBuiltinRegistrations,
    createShowWidgetTools,
    createToolPresentation,
    createTools,
    SHOW_WIDGET_EXTERNAL_RESOURCE_SELECTOR,
} from '@/modules/tools';
import { readMcpServerNames } from '@/modules/tools';
const historyQueries = createAgentHistoryQueries({
    tools: agentPresentation,
    readServerNames: readMcpServerNames,
    tt,
    error: () => {},
});
const loadSessionHistory = async (id: number) => (await historyQueries.loadSession(id)).history;

afterEach(() => {
    closeTestDatabases();
    clearMocks();
});

function response(input: {
    content?: string;
    call?: { name: string; arguments: string };
    model?: string;
}): Response {
    const common = { id: 'fixture-completion', created: 1, model: input.model ?? 'fixture-model' };
    const delta = input.call
        ? {
              role: 'assistant',
              tool_calls: [
                  { index: 0, id: 'fixture-call', type: 'function', function: input.call },
              ],
          }
        : { role: 'assistant', content: input.content ?? 'answer' };
    return new Response(
        [
            `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}`,
            `data: ${JSON.stringify({
                ...common,
                choices: [
                    { index: 0, delta: {}, finish_reason: input.call ? 'tool_calls' : 'stop' },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            })}`,
            'data: [DONE]',
        ].join('\n\n') + '\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
    );
}

async function fixture(
    replies: (() => Response)[],
    queryOptions: Parameters<typeof routeQueriesTo>[1] = {}
) {
    mockWindows('main');
    const database = openMigratedDatabase();
    routeQueriesTo(database, queryOptions);
    database.exec(`INSERT INTO providers (id, name, driver, api_endpoint, api_key, logo)
        VALUES (1, 'Fixture', 'openai-compatible', 'https://fixture.invalid/v1', 'fixture-secret', 'openai');
        INSERT INTO models (id, provider_id, name, model_id, is_default, tool_call, context_limit, output_limit)
        VALUES (1, 1, 'Fixture', 'fixture-model', 1, 1, 8192, 1024);`);
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const registry = createModels({
        providers: [
            {
                driver: 'openai-compatible',
                create: (config, host) => new OpenAICompatibleProviderAdapter(config, host),
            },
        ],
    });
    const connections = createModelsModule({
        createProvider: registry.createConnection,
        readConnectionState,
        fetch: async (input, init) => {
            requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
            const reply = replies.shift();
            if (!reply) throw new Error('unexpected network request');
            return reply();
        },
        createResources: () => ({
            remoteRefs: { read: async () => null, touch: async () => {}, write: async () => {} },
            resourceKey: () => undefined,
            dispose: () => {},
        }),
    });
    const descriptors = [
        ...createAskUserTools({ t, tt }),
        ...createShowWidgetTools({
            messages: { t, tt },
            markup: createWidgetMarkupInspector(SHOW_WIDGET_EXTERNAL_RESOURCE_SELECTOR),
        }),
    ];
    const builtins = createBuiltinRegistrations(descriptors);
    const presentation = createToolPresentation(descriptors, { t, tt });
    await builtins.synchronize();
    const tools = createTools({
        registrations: builtins.registrations,
        formatError: (code) => code,
    });
    const bindings = createTaskModelBindings({ selection: createModelSelection(), connections });
    const workflow = createMainAgentWorkflow({
        models: bindings,
        disposeModels: bindings.dispose,
        tools,
        sessions: {
            beforeStart: async () => {},
            loadHistory: loadSessionHistory,
            messages: { tt, errorText: (code) => code, retryText: (attempt) => `Retry ${attempt}` },
            tools: presentation,
        },
        diagnostics: { warn: () => {}, error: () => {} },
        createObservations: () => ({
            stream: () => {},
            event: () => {},
            attachmentPrepared: () => {},
            terminal: () => {},
            dispose: () => {},
        }),
        releaseActivity: async () => {},
    });
    const assembly = assembleAgentHost(workflow);
    return {
        database,
        requests,
        sessions: assembly.sessions,
        async dispose() {
            await assembly.dispose();
            tools.dispose();
            connections.dispose();
        },
    };
}

describe('given main connects the actual Core, provider driver, controlled tools and atomic history writer', () => {
    it('user receives a committed answer and a safe projection through the instance-created host', async () => {
        const input = await fixture([() => response({ content: 'committed answer' })]);
        try {
            const started = await input.sessions.startTask({ prompt: 'fixture request' });
            expect((await started.completion).response).toBe('committed answer');
            expect(input.database.prepare(`SELECT status FROM session_turns`).get()).toEqual({
                status: 'completed',
            });
            expect(
                input.database
                    .prepare(
                        `SELECT content FROM message_parts WHERE type = 'text' ORDER BY id DESC LIMIT 1`
                    )
                    .get()
            ).toEqual({ content: 'committed answer' });
            expect(input.requests[0]?.body).toMatchObject({ model: 'fixture-model' });
            expect(JSON.stringify(input.sessions.getTaskSnapshot(started.taskId))).not.toMatch(
                /fixture-secret|checkpoint_json|prompt_snapshot_json/
            );
            const sessionId = input.sessions.getTaskSnapshot(started.taskId)?.sessionId;
            expect((await loadSessionHistory(sessionId!)).at(-1)?.content).toBe('committed answer');
        } finally {
            await input.dispose();
        }
    });

    it('user keeps an invalid Widget call in audited history while filtering its draft cannot bypass execution validation', async () => {
        const input = await fixture([
            () => response({ call: { name: 'builtin__show_widget', arguments: '{}' } }),
            () => response({ content: 'validation explained' }),
        ]);
        try {
            const started = await input.sessions.startTask({ prompt: 'fixture request' });
            expect((await started.completion).response).toBe('validation explained');
            const toolPart = input.database
                .prepare(`SELECT data FROM message_parts WHERE type = 'tool_call'`)
                .get();
            expect(JSON.parse(String(toolPart?.data))).toMatchObject({
                toolCallId: 'fixture-call',
                status: 'error',
                output: 'invalid_arguments',
            });
            expect(JSON.stringify(input.requests[1]?.body)).toContain('invalid_arguments');
            const projection = input.sessions.getTaskSnapshot(started.taskId)!;
            expect(projection.sessionHistory.flatMap((message) => message.widgets ?? [])).toEqual(
                []
            );
            expect(
                projection.sessionHistory
                    .flatMap((message) => message.parts)
                    .find((part) => part.type === 'tool_call')
            ).toMatchObject({ toolCall: { id: 'fixture-call', status: 'error' } });
        } finally {
            await input.dispose();
        }
    });

    it('user settles a Core-owned question once and a duplicate reply cannot affect the following model request', async () => {
        const input = await fixture([
            () =>
                response({
                    call: {
                        name: 'builtin__ask_user_question',
                        arguments: JSON.stringify({
                            questions: [
                                {
                                    question: 'Choose a direction',
                                    header: 'Direction',
                                    options: [{ label: 'Left' }, { label: 'Right' }],
                                },
                            ],
                        }),
                    },
                }),
            () => response({ content: 'Left selected' }),
        ]);
        try {
            const started = await input.sessions.startTask({ prompt: 'fixture request' });
            await expect
                .poll(
                    () =>
                        input.sessions.getTaskSnapshot(started.taskId)?.pendingUserQuestion
                            ?.decisionId
                )
                .toBeTruthy();
            const question = input.sessions.getTaskSnapshot(started.taskId)!.pendingUserQuestion!;
            const answer = [{ questionIndex: 0, selectedLabels: ['Left'], skipped: false }];
            expect(
                input.sessions.settleTaskUserQuestion(
                    started.taskId,
                    question.callId,
                    answer,
                    'stale'
                )
            ).toBe(false);
            expect(
                input.sessions.settleTaskUserQuestion(
                    started.taskId,
                    question.callId,
                    answer,
                    question.decisionId
                )
            ).toBe(true);
            expect(
                input.sessions.settleTaskUserQuestion(
                    started.taskId,
                    question.callId,
                    answer,
                    question.decisionId
                )
            ).toBe(false);
            expect((await started.completion).response).toBe('Left selected');
            expect(JSON.stringify(input.requests[1]?.body)).toContain('answered: Left');
            expect(input.sessions.getTaskSnapshot(started.taskId)?.pendingUserQuestion).toBeNull();
        } finally {
            await input.dispose();
        }
    });

    it('user receives failure instead of a successful answer when the committed terminal write is refused', async () => {
        const input = await fixture([() => response({ content: 'not committed' })]);
        input.database.exec(`CREATE TEMP TRIGGER reject_terminal BEFORE UPDATE ON session_turns
            WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture terminal refusal'); END;`);
        try {
            const started = await input.sessions.startTask({ prompt: 'fixture request' });
            await expect(started.completion).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
            expect(input.sessions.getTaskSnapshot(started.taskId)?.status).toBe('failed');
            expect(input.database.prepare(`SELECT status FROM session_turns`).get()).toEqual({
                status: 'streaming',
            });
            expect(input.requests).toHaveLength(1);
        } finally {
            await input.dispose();
        }
    });

    it('user cannot start another task after main releases its host lifetime', async () => {
        const input = await fixture([() => response({ content: 'answer' })]);
        await input.dispose();
        await expect(input.sessions.startTask({ prompt: 'late request' })).rejects.toMatchObject({
            code: 'AGENT_DISPOSED',
        });
        expect(input.requests).toEqual([]);
        expect(input.database.prepare(`SELECT count(*) AS count FROM session_turns`).get()).toEqual(
            { count: 0 }
        );
    });

    for (const target of ['models', 'built_in_tools']) {
        it(`user cancels a task while a native ${target === 'models' ? 'model lookup' : 'tool configuration read'} ignores abort and late completion starts no execution`, async () => {
            let enabled = false;
            let paused = false;
            let resume!: () => void;
            const pending = new Promise<void>((resolve) => {
                resume = resolve;
            });
            const input = await fixture([], {
                beforeQuery: (request) => {
                    if (
                        enabled &&
                        request.sql.startsWith('select') &&
                        request.sql.includes(`"${target}"`)
                    ) {
                        paused = true;
                        return pending;
                    }
                },
            });
            enabled = true;
            try {
                const started = await input.sessions.startTask({
                    prompt: 'cancel during preparation',
                });
                await expect.poll(() => paused).toBe(true);
                expect(input.sessions.cancelTask(started.taskId)).toBe(true);
                await expect
                    .poll(() => input.sessions.getTaskSnapshot(started.taskId)?.status, {
                        timeout: 1000,
                    })
                    .toBe('cancelled');
                await expect(started.completion).rejects.toMatchObject({
                    code: 'REQUEST_CANCELLED',
                });
                expect(input.sessions.getTaskSnapshot(started.taskId)?.status).toBe('cancelled');
                expect(input.requests).toEqual([]);
                expect(
                    input.database.prepare(`SELECT count(*) AS count FROM session_turns`).get()
                ).toEqual({ count: 0 });
                enabled = false;
                resume();
                await Promise.resolve();
                expect(input.requests).toEqual([]);
            } finally {
                enabled = false;
                resume();
                await input.dispose();
            }
        });
    }
});
