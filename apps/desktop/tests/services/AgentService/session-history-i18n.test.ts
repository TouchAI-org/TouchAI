import type { SessionTurnAttemptHistoryRow } from '@database/queries/sessionTurnAttempts';
import type { SessionTurnHistoryRow } from '@database/queries/sessionTurns';
import { createMessagePart, createMessageRow } from '@tests/utils/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { buildSessionHistory } from '@/services/AgentService/session/history';

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
                    parts: [
                        createMessagePart({
                            type: 'tool_call',
                            data: JSON.stringify({
                                toolCallId: 'call-1',
                                toolKind: 'builtin',
                                tool_id: 'bash',
                                input: JSON.stringify({ command: 'Write-Output 设置' }),
                                status: 'success',
                                duration_ms: 12,
                            }),
                        }),
                    ],
                }),
                createMessageRow({
                    id: 12,
                    role: 'tool_result',
                    content: '[命令无输出]',
                    parts: [
                        createMessagePart({
                            type: 'tool_result',
                            content: '[命令无输出]',
                            data: JSON.stringify({ toolCallId: 'call-1', toolKind: 'builtin' }),
                        }),
                    ],
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
                    parts: [
                        {
                            id: 1,
                            message_id: 2,
                            type: 'reasoning',
                            content: 'Plan',
                            data: '{}',
                            tool_call_id: null,
                            tool_kind: null,
                            attachment_id: null,
                            started_at: null,
                            ended_at: null,
                            sort_order: 0,
                            created_at: BASE_TIME,
                            updated_at: BASE_TIME,
                        },
                        {
                            id: 2,
                            message_id: 2,
                            type: 'text',
                            content: 'Checking',
                            data: '{}',
                            tool_call_id: null,
                            tool_kind: null,
                            attachment_id: null,
                            started_at: null,
                            ended_at: null,
                            sort_order: 1,
                            created_at: BASE_TIME,
                            updated_at: BASE_TIME,
                        },
                        createMessagePart({
                            id: 7,
                            message_id: 2,
                            type: 'tool_call',
                            sort_order: 2,
                            data: JSON.stringify({
                                toolCallId: 'call-1',
                                toolKind: 'builtin',
                                tool_id: 'bash',
                                input: '{}',
                                status: 'success',
                            }),
                        }),
                    ],
                }),
                createMessageRow({
                    id: 3,
                    role: 'assistant',
                    parts: [
                        {
                            id: 3,
                            message_id: 3,
                            type: 'reasoning',
                            content: 'Review',
                            data: '{}',
                            tool_call_id: null,
                            tool_kind: null,
                            attachment_id: null,
                            started_at: null,
                            ended_at: null,
                            sort_order: 0,
                            created_at: BASE_TIME,
                            updated_at: BASE_TIME,
                        },
                        {
                            id: 4,
                            message_id: 3,
                            type: 'text',
                            content: 'Answer',
                            data: '{}',
                            tool_call_id: null,
                            tool_kind: null,
                            attachment_id: null,
                            started_at: null,
                            ended_at: null,
                            sort_order: 1,
                            created_at: BASE_TIME,
                            updated_at: BASE_TIME,
                        },
                    ],
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

describe('uncommitted output history', () => {
    it('does not invent assistant content for an in-progress attempt without a saved message', async () => {
        const history = await buildSessionHistory({
            messages: [createMessageRow({ id: 10, role: 'user', content: 'Question' })],
            turns: [createTurn({ prompt_message_id: 10, status: 'streaming' })],
            attempts: [createAttempt({ status: 'streaming', finished_at: null })],
            resolveServerName: () => '',
        });
        expect(history.filter((message) => message.role === 'assistant')).toEqual([]);
    });
});

describe('reasoning wall-clock history', () => {
    it('freezes interrupted reasoning at the last durable timestamp, not reopen time', async () => {
        const startedAt = Date.parse(BASE_TIME);
        const history = await buildSessionHistory({
            messages: [
                createMessageRow({
                    id: 11,
                    role: 'assistant',
                    parts: [
                        {
                            id: 5,
                            message_id: 11,
                            type: 'reasoning',
                            content: '',
                            data: '{}',
                            tool_call_id: null,
                            tool_kind: null,
                            attachment_id: null,
                            started_at: startedAt,
                            ended_at: null,
                            sort_order: 0,
                            created_at: BASE_TIME,
                            updated_at: '2026-05-22T10:00:04.000Z',
                        },
                    ],
                }),
            ],
            turns: [],
            attempts: [],
            resolveServerName: () => '',
        });
        expect(history[0]?.parts[0]).toMatchObject({
            type: 'reasoning',
            startedAt,
            endedAt: startedAt + 4000,
            isStreaming: false,
        });
    });

    it('keeps segment start and end times when restoring a completed message', async () => {
        const history = await buildSessionHistory({
            messages: [
                createMessageRow({
                    id: 11,
                    role: 'assistant',
                    content: 'Answer',
                    parts: [
                        {
                            id: 5,
                            message_id: 11,
                            type: 'reasoning',
                            content: 'Thought',
                            data: '{}',
                            tool_call_id: null,
                            tool_kind: null,
                            attachment_id: null,
                            started_at: 1000,
                            ended_at: 3400,
                            sort_order: 0,
                            created_at: BASE_TIME,
                            updated_at: BASE_TIME,
                        },
                        {
                            id: 6,
                            message_id: 11,
                            type: 'text',
                            content: 'Answer',
                            data: '{}',
                            tool_call_id: null,
                            tool_kind: null,
                            attachment_id: null,
                            started_at: null,
                            ended_at: null,
                            sort_order: 1,
                            created_at: BASE_TIME,
                            updated_at: BASE_TIME,
                        },
                    ],
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
