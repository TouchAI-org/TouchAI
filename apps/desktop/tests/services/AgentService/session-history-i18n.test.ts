import type { MessageRow } from '@database/queries/messages';
import type { SessionTurnAttemptHistoryRow } from '@database/queries/sessionTurnAttempts';
import type { SessionTurnHistoryRow } from '@database/queries/sessionTurns';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { buildSessionHistory } from '@/services/AgentService/session/history';
import type { PersistedOutputPart } from '@/services/AgentService/session/reasoningProgress';

const BASE_TIME = '2026-05-22T10:00:00.000Z';

vi.mock('@/services/BuiltInToolService/registry', () => ({
    builtInToolRegistry: {
        get: (toolId: string) =>
            toolId === 'bash'
                ? {
                      id: 'bash',
                      displayName: 'Bash',
                      buildConversationSemantic: (args: Record<string, unknown>) => ({
                          action: 'run',
                          target: typeof args.command === 'string' ? args.command : 'Bash',
                      }),
                  }
                : null,
        list: () => [
            {
                id: 'bash',
                displayName: 'Bash',
            },
        ],
    },
}));

vi.mock('@/services/BuiltInToolService/tools/widgetTool', () => ({
    SHOW_WIDGET_TOOL_NAME: 'builtin__show_widget',
}));

function createMessageRow(overrides: Partial<MessageRow>): MessageRow {
    return {
        id: 1,
        session_id: 1,
        role: 'user',
        content: '',
        reasoning: null,
        reasoning_meta: null,
        attachments: [],
        tool_call_id: null,
        tool_name: null,
        tool_input: null,
        tool_log_ref_id: null,
        tool_status: null,
        tool_duration_ms: null,
        server_id: null,
        builtin_conversation_semantic_json: null,
        tool_log_id: null,
        tool_log_kind: null,
        created_at: BASE_TIME,
        updated_at: BASE_TIME,
        ...overrides,
    };
}

function createTurn(overrides: Partial<SessionTurnHistoryRow>): SessionTurnHistoryRow {
    return {
        id: 1,
        session_id: 1,
        task_id: 'task-1',
        execution_mode: 'foreground',
        prompt_snapshot_json: '{}',
        prompt_message_id: null,
        response_message_id: null,
        status: 'completed',
        error_message: null,
        created_at: BASE_TIME,
        updated_at: BASE_TIME,
        ...overrides,
    };
}

function createAttempt(
    overrides: Partial<SessionTurnAttemptHistoryRow>
): SessionTurnAttemptHistoryRow {
    return {
        id: 1,
        turn_id: 1,
        attempt_index: 1,
        max_retries: 5,
        status: 'failed',
        checkpoint_json: '{}',
        reasoning_progress_json: null,
        delivery_manifest_json: '{}',
        error_message: null,
        started_at: BASE_TIME,
        finished_at: BASE_TIME,
        created_at: BASE_TIME,
        updated_at: BASE_TIME,
        ...overrides,
    };
}

describe('AgentService session history i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
        let uuidIndex = 0;
        vi.spyOn(crypto, 'randomUUID').mockImplementation(
            () => `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, '0')}`
        );
    });

    it('localizes derived failed, retry, and cancelled statuses while preserving payload text', async () => {
        setLocale('en-US');

        const history = await buildSessionHistory({
            messages: [
                createMessageRow({
                    id: 10,
                    role: 'user',
                    content: '用户输入原文',
                }),
                createMessageRow({
                    id: 11,
                    role: 'assistant',
                    content: '模型输出原文',
                }),
            ],
            turns: [
                createTurn({
                    id: 1,
                    prompt_message_id: 10,
                    response_message_id: 11,
                    status: 'failed',
                    error_message: '模型返回了空回复，请尝试重新提问或更换模型',
                }),
                createTurn({
                    id: 2,
                    prompt_message_id: 10,
                    response_message_id: 11,
                    status: 'cancelled',
                }),
            ],
            attempts: [
                createAttempt({
                    id: 1,
                    turn_id: 1,
                    attempt_index: 1,
                    max_retries: 5,
                    status: 'failed',
                }),
                createAttempt({
                    id: 2,
                    turn_id: 1,
                    attempt_index: 2,
                    max_retries: 5,
                    status: 'completed',
                }),
            ],
            resolveServerName: () => '',
        });

        expect(history[0]?.content).toBe('用户输入原文');
        expect(history[2]?.content).toBe('模型输出原文');
        expect(history[1]).toMatchObject({
            role: 'assistant',
            content: 'Retrying... (1/5)',
            isRetrying: true,
        });
        expect(history[2]?.statusText).toBe(
            'Request failed: The model returned an empty response. Try asking again or switch models.\nRequest cancelled'
        );
    });

    it('rebuilds unsupported file endpoint errors as friendly model capability messages', async () => {
        setLocale('zh-CN');

        const history = await buildSessionHistory({
            messages: [
                createMessageRow({
                    id: 10,
                    role: 'user',
                    content: '继续刚才的对话',
                }),
            ],
            turns: [
                createTurn({
                    id: 1,
                    prompt_message_id: 10,
                    status: 'failed',
                    error_message: 'No endpoints found that support file input',
                }),
            ],
            attempts: [],
            resolveServerName: () => '',
        });

        expect(history[1]).toMatchObject({
            role: 'assistant',
            content: '请求失败: 当前模型不支持图片/文件输入，请选择合适模型继续。',
            isError: true,
        });
    });

    it('localizes restored built-in tool presentation verbs in English history', async () => {
        setLocale('en-US');

        const history = await buildSessionHistory({
            messages: [
                createMessageRow({
                    id: 10,
                    role: 'user',
                    content: 'run command',
                }),
                createMessageRow({
                    id: 11,
                    role: 'tool_call',
                    content: '',
                    tool_call_id: 'call-1',
                    tool_name: 'builtin__bash',
                    tool_input: JSON.stringify({ command: 'Write-Output 设置' }),
                    tool_status: 'success',
                }),
                createMessageRow({
                    id: 12,
                    role: 'tool_result',
                    content: '[命令无输出]',
                    tool_call_id: 'call-1',
                    tool_name: 'builtin__bash',
                    tool_input: JSON.stringify({ command: 'Write-Output 设置' }),
                    tool_status: 'success',
                    tool_duration_ms: 12,
                }),
            ],
            turns: [],
            attempts: [],
            resolveServerName: () => '',
        });

        const toolCall = history[1]?.toolCalls?.[0];
        expect(toolCall?.builtinPresentation).toMatchObject({
            verb: 'Ran',
            content: 'Write-Output 设置',
        });
    });
});

describe('AgentService interleaved reasoning history', () => {
    it('restores each reasoning block beside its own text and tool calls', async () => {
        const history = await buildSessionHistory({
            messages: [
                createMessageRow({ id: 1, role: 'user', content: 'Question' }),
                createMessageRow({
                    id: 2,
                    role: 'tool_call',
                    reasoning: 'Plan',
                    content: 'Checking',
                    tool_call_id: 'call-1',
                    tool_name: 'builtin__bash',
                    tool_input: '{}',
                    tool_log_ref_id: 1,
                    tool_status: 'success',
                }),
                createMessageRow({
                    id: 3,
                    role: 'assistant',
                    reasoning: 'Review',
                    content: 'Answer',
                }),
            ],
            turns: [],
            attempts: [],
            resolveServerName: () => 'Tools',
        });
        const assistant = history.find((message) => message.role === 'assistant')!;
        expect(assistant.parts).toMatchObject([
            { type: 'reasoning', content: 'Plan', isStreaming: false },
            { type: 'text', content: 'Checking' },
            { type: 'tool_call', callId: 'call-1' },
            { type: 'reasoning', content: 'Review', isStreaming: false },
            { type: 'text', content: 'Answer' },
        ]);
        expect(assistant.reasoning).toBe('PlanReview');
    });
});

describe('interrupted reasoning progress', () => {
    it('recovers saved reasoning after its prompt even without a persisted assistant message', async () => {
        const history = await buildSessionHistory({
            messages: [
                createMessageRow({ id: 10, role: 'user', content: 'First prompt' }),
                createMessageRow({ id: 20, role: 'user', content: 'Next prompt' }),
            ],
            turns: [createTurn({ prompt_message_id: 10, status: 'streaming' })],
            attempts: [
                createAttempt({
                    status: 'streaming',
                    finished_at: null,
                    reasoning_progress_json: JSON.stringify({
                        segments: [{ content: 'Saved thought', startedAt: 1000 }],
                        savedAt: 6500,
                    }),
                }),
            ],
            resolveServerName: () => '',
        });

        expect(history.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
        expect(history[1]?.parts).toEqual([
            expect.objectContaining({
                type: 'reasoning',
                content: 'Saved thought',
                startedAt: 1000,
                endedAt: 6500,
                isStreaming: false,
            }),
        ]);
        expect(history[1]?.reasoning).toBe('Saved thought');
    });
});

describe('reasoning wall-clock history', () => {
    it('keeps segment start and end times when restoring a completed message', async () => {
        const history = await buildSessionHistory({
            messages: [
                createMessageRow({
                    id: 11,
                    role: 'assistant',
                    content: 'Answer',
                    reasoning: 'Thought',
                    reasoning_meta: JSON.stringify([
                        { content: 'Thought', startedAt: 1000, endedAt: 3400 },
                    ]),
                }),
            ],
            turns: [],
            attempts: [],
            resolveServerName: () => '',
        });
        expect(history[0]?.parts[0]).toMatchObject({
            type: 'reasoning',
            content: 'Thought',
            startedAt: 1000,
            endedAt: 3400,
        });
    });
});

describe('assistant output progress history', () => {
    it('restores an interrupted answer without any reasoning or assistant message', async () => {
        const history = await buildSessionHistory({
            messages: [createMessageRow({ id: 10, role: 'user', content: 'Question' })],
            turns: [createTurn({ prompt_message_id: 10, status: 'streaming' })],
            attempts: [
                createAttempt({
                    status: 'streaming',
                    finished_at: null,
                    reasoning_progress_json: JSON.stringify({
                        response: 'Saved partial answer',
                        segments: [],
                        savedAt: 6500,
                    }),
                }),
            ],
            resolveServerName: () => '',
        });
        expect(history[1]).toMatchObject({
            role: 'assistant',
            content: 'Saved partial answer',
            parts: [{ type: 'text', content: 'Saved partial answer' }],
        });
    });

    it.each(['interrupted', 'completed'] as const)(
        'preserves reasoning and answer order for %s output',
        async (status) => {
            const segments = [
                { content: 'Plan', startedAt: 1000, endedAt: 2000, textOffset: 0 },
                {
                    content: 'Review',
                    startedAt: 3000,
                    ...(status === 'completed' ? { endedAt: 5000 } : {}),
                    textOffset: 5,
                },
            ];
            const history = await buildSessionHistory({
                messages: [
                    createMessageRow({ id: 10, role: 'user', content: 'Question' }),
                    ...(status === 'completed'
                        ? [
                              createMessageRow({
                                  id: 11,
                                  role: 'assistant',
                                  content: 'IntroAnswer',
                                  reasoning: 'PlanReview',
                                  reasoning_meta: JSON.stringify(segments),
                              }),
                          ]
                        : []),
                ],
                turns:
                    status === 'completed'
                        ? []
                        : [createTurn({ prompt_message_id: 10, status: 'streaming' })],
                attempts:
                    status === 'completed'
                        ? []
                        : [
                              createAttempt({
                                  status: 'streaming',
                                  finished_at: null,
                                  reasoning_progress_json: JSON.stringify({
                                      response: 'IntroAnswer',
                                      segments,
                                      savedAt: 6500,
                                  }),
                              }),
                          ],
                resolveServerName: () => '',
            });
            expect(history[1]).toMatchObject({
                role: 'assistant',
                content: 'IntroAnswer',
                reasoning: 'PlanReview',
                parts: [
                    {
                        type: 'reasoning',
                        content: 'Plan',
                        startedAt: 1000,
                        endedAt: 2000,
                        isStreaming: false,
                    },
                    { type: 'text', content: 'Intro' },
                    {
                        type: 'reasoning',
                        content: 'Review',
                        startedAt: 3000,
                        endedAt: status === 'completed' ? 5000 : 6500,
                        isStreaming: false,
                    },
                    { type: 'text', content: 'Answer' },
                ],
            });
        }
    );

    it.each(['reasoning', 'text', 'shared prefix'] as const)(
        'keeps repeated %s from a later tool round in version 2 progress',
        async (kind) => {
            const earlier: PersistedOutputPart[] =
                kind === 'reasoning'
                    ? [{ type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 2000 }]
                    : [{ type: 'text', content: 'Checking' }];
            const later: PersistedOutputPart[] =
                kind === 'reasoning'
                    ? [{ type: 'reasoning', content: 'Plan', startedAt: 5000, endedAt: 6000 }]
                    : [
                          { type: 'text', content: 'Checking' },
                          ...(kind === 'shared prefix'
                              ? [
                                    {
                                        type: 'reasoning' as const,
                                        content: 'Review',
                                        startedAt: 5000,
                                        endedAt: 6000,
                                    },
                                ]
                              : []),
                      ];
            const history = await buildSessionHistory({
                messages: [
                    createMessageRow({ id: 10, role: 'user', content: 'Question' }),
                    createMessageRow({
                        id: 11,
                        role: 'tool_call',
                        content: kind === 'reasoning' ? '' : 'Checking',
                        reasoning: kind === 'reasoning' ? 'Plan' : null,
                        reasoning_meta: JSON.stringify({ version: 2, parts: earlier }),
                        tool_call_id: 'call-1',
                        tool_name: 'builtin__bash',
                        tool_input: JSON.stringify({ command: 'echo test' }),
                    }),
                    createMessageRow({
                        id: 12,
                        role: 'tool_result',
                        content: 'test',
                        tool_call_id: 'call-1',
                        tool_status: 'success',
                    }),
                ],
                turns: [createTurn({ prompt_message_id: 10, status: 'streaming' })],
                attempts: [
                    createAttempt({
                        status: 'streaming',
                        finished_at: null,
                        reasoning_progress_json: JSON.stringify({
                            version: 2,
                            parts: later,
                            savedAt: 6500,
                        }),
                    }),
                ],
                resolveServerName: () => '',
            });
            expect(history[1]?.parts).toMatchObject([...earlier, { type: 'tool_call' }, ...later]);
            expect(history[1]?.content).toBe(kind === 'reasoning' ? '' : 'CheckingChecking');
        }
    );

    it('does not duplicate output already committed atomically with a tool-call message', async () => {
        const progress = {
            response: 'Checking',
            segments: [{ content: 'Plan', startedAt: 1000, endedAt: 2000, textOffset: 0 }],
            savedAt: 2500,
        };
        const history = await buildSessionHistory({
            messages: [
                createMessageRow({ id: 10, role: 'user', content: 'Question' }),
                createMessageRow({
                    id: 11,
                    role: 'tool_call',
                    content: 'Checking',
                    reasoning: 'Plan',
                    reasoning_meta: JSON.stringify(progress.segments),
                }),
            ],
            turns: [createTurn({ prompt_message_id: 10, status: 'streaming' })],
            attempts: [
                createAttempt({
                    status: 'streaming',
                    finished_at: null,
                    reasoning_progress_json: JSON.stringify(progress),
                }),
            ],
            resolveServerName: () => '',
        });

        expect(history[1]).toMatchObject({
            role: 'assistant',
            content: 'Checking',
            reasoning: 'Plan',
            parts: [
                { type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 2000 },
                { type: 'text', content: 'Checking' },
            ],
        });
    });
});
