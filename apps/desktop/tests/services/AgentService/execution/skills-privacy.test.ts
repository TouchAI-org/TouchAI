import type { SQLInputValue } from 'node:sqlite';

import {
    flushObservability,
    initObservability,
    resetObservabilityForTests,
} from '@services/ObservabilityService';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { closeTestDatabases, openMigratedDatabase } from '@tests/database/sqliteHarness';
import { installSkillCommands, skillFile, widgetSkillFile } from '@tests/utils/skills';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import type { AiStreamChunk } from '@/services/AgentService/contracts/protocol';
import { AiRequestExecutor } from '@/services/AgentService/execution';
import { AiConversationRuntime, type TurnEvent } from '@/services/AgentService/execution/runtime';
import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';

const { httpFetch } = vi.hoisted(() => ({ httpFetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));

const privateMarker = 'PRIVATE_SKILL_BODY_MUST_NOT_LEAVE_EXECUTION';
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
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, api_key, logo) VALUES (1, 'Test', 'openai-compatible', 'https://controlled.test/v1', 'test', '');
        INSERT INTO models (id, provider_id, name, model_id, is_default, tool_call) VALUES (1, 1, 'Test', 'test-model', 1, 1);
        INSERT INTO built_in_tools (tool_id, display_name, enabled, risk_level) VALUES ('activate_skill', 'ActivateSkill', 1, 'medium');
        INSERT INTO built_in_tools (tool_id, display_name, enabled, risk_level) VALUES ('show_widget', 'ShowWidget', 1, 'low');
    `);
    for (const command of ['database_query', 'database_tx_query']) {
        mockTauriCommand(command, (payload?: InvokeArgs) => {
            const { request } = payload as {
                request: { sql: string; params: SQLInputValue[]; method: string };
            };
            const statement = database.prepare(request.sql);
            if (request.method === 'run') {
                const result = statement.run(...request.params);
                return {
                    rows: [],
                    rowsAffected: Number(result.changes),
                    lastInsertId: Number(result.lastInsertRowid),
                };
            }
            return { rows: statement.all(...request.params), rowsAffected: 0, lastInsertId: null };
        });
    }
    mockTauriCommand('database_tx_begin', () => {
        database.exec('BEGIN');
        return 'test-tx';
    });
    mockTauriCommand('database_tx_commit', () => {
        database.exec('COMMIT');
    });
    mockTauriCommand('database_tx_rollback', () => {
        database.exec('ROLLBACK');
    });
    const file = skillFile();
    installSkillCommands(
        [{ ...file, content: `${file.frontmatter}${privateMarker}` }],
        [widgetSkillFile()]
    );
    initObservability();
});

afterEach(() => {
    resetObservabilityForTests();
    closeTestDatabases();
});

describe('given a skill is activated during a conversation that needs a retry', () => {
    it('user activates a widget skill then creates a widget and retains both completed exchanges as verifiable compaction sources', async () => {
        const widgetPath = '/app/skills/.system/widget/SKILL.md';
        const checkpoints: TurnEvent[] = [];
        let step = 0;
        httpFetch.mockImplementation(async (_url, init) => {
            step++;
            if (step === 1)
                return widgetResponse(
                    'builtin__activate_skill',
                    { path: widgetPath },
                    'read-widget'
                );
            if (step === 2) {
                const key = init.body.match(
                    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/
                )?.[0];
                expect(key).toBeTruthy();
                return widgetResponse(
                    'builtin__show_widget',
                    {
                        skill_key: key,
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

    it('user never sees a widget draft when the model supplies the old acknowledgement without a read credential', async () => {
        httpFetch
            .mockResolvedValueOnce(
                widgetResponse('builtin__show_widget', {
                    i_have_seen_read_me: true,
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
    });

    it.each([false, true])(
        'user can create and retry a widget with a private read credential when explicit selection is %s',
        async (selected) => {
            const widgetPath = '/app/skills/.system/widget/SKILL.md';
            const requests: string[] = [];
            const chunks: AiStreamChunk[] = [];
            const events: TurnEvent[] = [];
            let key: string | undefined;
            let step = selected ? 1 : 0;
            httpFetch.mockImplementation(async (_url, init) => {
                const body = JSON.parse(init.body) as {
                    messages: Array<{ role: string; content: string }>;
                };
                requests.push(init.body);
                const guide = body.messages.find(
                    (message) =>
                        typeof message.content === 'string' &&
                        message.content.includes('<path>/app/skills/.system/widget/SKILL.md</path>')
                )?.content;
                key ??= guide?.match(
                    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/
                )?.[0];
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
                            skill_key: key ?? 'missing-current-key',
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
                onChunk: (chunk) => chunks.push(chunk),
                onTurnEvent: (event) => events.push(event),
            }).run();
            expect(result.response).toBe('Three concise points.');
            expect(key).toBeTruthy();
            expect(
                chunks.filter(
                    (chunk) =>
                        chunk.toolEvent?.type === 'widget_upsert' &&
                        chunk.toolEvent.phase === 'ready'
                )
            ).toHaveLength(2);
            expect(events.some((event) => event.type === 'retry_scheduled')).toBe(true);
            expect(requests[requests.length - 1]).toContain(key!);
            expect(JSON.stringify(chunks)).not.toContain(key!);
            expect(JSON.stringify(events)).not.toContain(key!);
            for (const { name } of database
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
                .all() as Array<{ name: string }>) {
                expect(
                    JSON.stringify(
                        database.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all()
                    )
                ).not.toContain(key!);
            }
            await flushObservability();
            expect(JSON.stringify(getTauriInvokeCalls('obs_ingest'))).not.toContain(key!);

            httpFetch.mockReset();
            httpFetch
                .mockResolvedValueOnce(
                    widgetResponse('builtin__show_widget', {
                        skill_key: key,
                        widget_code: '<section>Expired credential</section>',
                    })
                )
                .mockResolvedValueOnce(response());
            const nextChunks: AiStreamChunk[] = [];
            await new AiConversationRuntime(new AiRequestExecutor(), {
                prompt: 'Draw another',
                sessionId: result.turn!.session_id!,
                onChunk: (chunk) => nextChunks.push(chunk),
            }).run();
            expect(nextChunks.some((chunk) => chunk.toolEvent?.type === 'widget_upsert')).toBe(
                false
            );
            expect(nextChunks.flatMap((chunk) => chunk.toolCallDeltas ?? [])).toEqual([]);
        }
    );

    it('user can finish a turn after repeated model activations reach the instruction limit', async () => {
        setLocale('en-US');
        let calls = 0;
        let lastRequest = '';
        httpFetch.mockImplementation(async (_url, init) => {
            calls++;
            lastRequest = init.body;
            return calls <= 17 ? response(true, `skill-${calls}`) : response();
        });
        const result = await new AiConversationRuntime(new AiRequestExecutor(), {
            prompt: 'Summarize',
            requestToolApproval: async () => true,
        }).run();
        expect(result.response).toBe('Three concise points.');
        expect(lastRequest.split(privateMarker).length - 1).toBe(16);
        expect(lastRequest).toContain('Skill context limit reached');
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
                sessionId: first.turn!.session_id!,
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
        expect(first.turn?.session_id).toBeTypeOf('number');
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
            sessionId: first.turn!.session_id!,
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
            const events: TurnEvent[] = [];
            const chunks: unknown[] = [];
            const published: string[] = [];
            const snapshot: SessionTaskSnapshot = {
                taskId: 'privacy-task',
                sessionId: null,
                turnId: null,
                status: 'running',
                executionMode: 'foreground',
                prompt: 'Summarize',
                sessionHistory: [],
                pendingToolApproval: null,
                pendingApprovals: [],
                pendingUserQuestion: null,
                error: null,
                currentModel: null,
                promptSnapshot: null,
                lastCheckpoint: null,
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
