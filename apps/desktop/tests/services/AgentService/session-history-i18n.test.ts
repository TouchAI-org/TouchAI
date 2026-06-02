import type { MessageRow } from '@database/queries/messages';
import type { SessionTurnContextArtifactHistoryRow } from '@database/queries/sessionTurnContextArtifacts';
import type { SessionTurnAttemptHistoryRow } from '@database/queries/sessionTurnAttempts';
import type { SessionTurnHistoryRow } from '@database/queries/sessionTurns';
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
                      buildConversationSemanticFromResult: () => null,
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
        attachments: [],
        tool_call_id: null,
        tool_name: null,
        tool_input: null,
        tool_log_ref_id: null,
        tool_status: null,
        tool_duration_ms: null,
        server_id: null,
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
        delivery_manifest_json: '{}',
        error_message: null,
        started_at: BASE_TIME,
        finished_at: BASE_TIME,
        created_at: BASE_TIME,
        updated_at: BASE_TIME,
        ...overrides,
    };
}

function createContextArtifact(
    overrides: Partial<SessionTurnContextArtifactHistoryRow>
): SessionTurnContextArtifactHistoryRow {
    return {
        id: 1,
        turn_id: 1,
        prompt_message_id: 10,
        capsule_id: 'ctx-1',
        artifact_kind: 'metadata',
        artifact_path: null,
        mime_type: null,
        width: null,
        height: null,
        captured_at: BASE_TIME,
        metadata_json: null,
        created_at: BASE_TIME,
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

    it('restores persisted desktop context artifacts onto the prompt message', async () => {
        const history = await buildSessionHistory({
            messages: [
                createMessageRow({
                    id: 10,
                    role: 'user',
                    content: '解释我刚才选中的内容',
                }),
            ],
            turns: [
                createTurn({
                    id: 1,
                    prompt_message_id: 10,
                }),
            ],
            attempts: [],
            contextArtifacts: [
                createContextArtifact({
                    artifact_kind: 'metadata',
                    metadata_json: JSON.stringify({
                        capsuleId: 'ctx-1',
                        capturedAt: BASE_TIME,
                        summary: 'Visual Studio Code focused with selected Rust error text.',
                        activeWindowTitle: 'main.rs - TouchAI',
                    }),
                }),
                createContextArtifact({
                    id: 2,
                    artifact_kind: 'screenshot',
                    artifact_path: 'E:/TouchAI/data/session-context/ctx-1.png',
                    mime_type: 'image/png',
                    width: 1200,
                    height: 800,
                }),
            ],
            resolveServerName: () => '',
        });

        expect(history[0]).toMatchObject({
            role: 'user',
            desktopContext: {
                capsuleId: 'ctx-1',
                summary: 'Visual Studio Code focused with selected Rust error text.',
                activeWindowTitle: 'main.rs - TouchAI',
                screenshotPath: 'E:/TouchAI/data/session-context/ctx-1.png',
                screenshotWidth: 1200,
                screenshotHeight: 800,
            },
        });
    });
});
