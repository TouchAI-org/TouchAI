import { mountComposable } from '@tests/utils/composables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { useAgentState } from '@/composables/agent/useAgentState';
import { setLocale } from '@/i18n';
import type { SessionTaskSnapshot } from '@/services/AgentService';
import type { SessionMessage, ToolCallInfo } from '@/types/session';
import { selectToolCalls } from '@/utils/session';

const { subscribeTaskMock } = vi.hoisted(() => ({
    subscribeTaskMock: vi.fn(),
}));

vi.mock('@/services/AgentService', () => ({
    sessionTaskCenter: {
        subscribeTask: subscribeTaskMock,
    },
}));

function createToolCall(
    result: string,
    status: ToolCallInfo['status'] = 'executing'
): ToolCallInfo {
    return {
        id: 'call-bash-1',
        name: 'Bash',
        namespacedName: 'builtin__bash',
        source: 'builtin',
        sourceLabel: '内置工具',
        arguments: {
            command: 'Write-Output "stream-1"',
        },
        status,
        result,
    };
}

function createAssistantMessage(toolCall: ToolCallInfo): SessionMessage {
    return {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        parts: [
            {
                id: 'part-tool-call-1',
                type: 'tool_call',
                toolCall,
            },
        ],
        timestamp: Date.now(),
        isStreaming: toolCall.status === 'executing',
    };
}

function createSnapshot(toolCall: ToolCallInfo): SessionTaskSnapshot {
    const now = Date.now();
    return {
        taskId: 'task-1',
        sessionId: 7,
        turnId: 11,
        status: toolCall.status === 'executing' ? 'running' : 'completed',
        executionMode: 'foreground',
        sessionHistory: [createAssistantMessage(toolCall)],
        pendingToolApproval: null,
        pendingApprovals: [],
        pendingUserQuestion: null,
        error: null,
        currentModel: null,
        startedAt: now,
        updatedAt: now,
        modelSwitchCount: 0,
    };
}

describe('when a tool streams output into the conversation', () => {
    afterEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
    });

    it('user gets a generic failure when the task subscription cannot be established', async () => {
        setLocale('zh-CN');
        subscribeTaskMock.mockImplementation(() => {
            throw new Error('Task task-1 not found: internal lookup detail');
        });

        const mounted = await mountComposable(() => useAgentState());
        mounted.result.attachTaskView('task-1');

        expect(mounted.result.error.value?.message).toBe('未知错误');
        expect(mounted.result.error.value?.message).not.toContain('internal lookup detail');
        expect(mounted.result.attachedTaskId.value).toBeNull();

        mounted.unmount();
    });

    it('user gets a generic failure when a task snapshot contains internal diagnostics', async () => {
        setLocale('zh-CN');
        subscribeTaskMock.mockImplementation(
            (_taskId: string, callback: (snapshot: SessionTaskSnapshot) => void) => {
                callback({
                    ...createSnapshot(createToolCall('')),
                    status: 'failed',
                    error: 'database locked: /home/user/touchai.db',
                });
                return () => {};
            }
        );

        const mounted = await mountComposable(() => useAgentState());
        mounted.result.attachTaskView('task-1');
        await nextTick();

        expect(mounted.result.error.value?.message).toBe('未知错误');
        expect(mounted.result.error.value?.message).not.toContain('touchai.db');
        expect(mounted.result.isLoading.value).toBe(false);

        mounted.unmount();
    });

    it('user sees the localized task failure after a language change', async () => {
        setLocale('en-US');
        subscribeTaskMock.mockImplementation(
            (_taskId: string, callback: (snapshot: SessionTaskSnapshot) => void) => {
                callback({
                    ...createSnapshot(createToolCall('')),
                    status: 'failed',
                    error: 'API request failed.',
                });
                return () => {};
            }
        );

        const mounted = await mountComposable(() => useAgentState());
        mounted.result.attachTaskView('task-1');
        await nextTick();

        expect(mounted.result.error.value?.message).toBe('API request failed.');

        mounted.unmount();
    });

    it('user sees the tool output as it streams, before the tool finishes', async () => {
        let listener: ((snapshot: SessionTaskSnapshot) => void) | null = null;
        subscribeTaskMock.mockImplementation(
            (_taskId: string, callback: (snapshot: SessionTaskSnapshot) => void) => {
                listener = callback;
                callback(
                    createSnapshot(
                        createToolCall(
                            [
                                'Shell: powershell',
                                'Working directory: D:\\Project\\TouchAI',
                                'Exit code: none',
                                'Duration: 500ms',
                                '',
                                'stream-1',
                            ].join('\n')
                        )
                    )
                );
                return () => {};
            }
        );

        const mounted = await mountComposable(() => useAgentState());
        mounted.result.attachTaskView('task-1');
        await nextTick();

        const firstMessage = mounted.result.sessionHistory.value[0];
        expect(firstMessage ? selectToolCalls(firstMessage)[0] : undefined).toMatchObject({
            status: 'executing',
        });
        expect(firstMessage ? selectToolCalls(firstMessage)[0]?.result : undefined).toContain(
            'stream-1'
        );

        expect(listener).not.toBeNull();
        listener!(
            createSnapshot(
                createToolCall(
                    [
                        'Shell: powershell',
                        'Working directory: D:\\Project\\TouchAI',
                        'Exit code: none',
                        'Duration: 900ms',
                        '',
                        'stream-1\nstream-2',
                    ].join('\n')
                )
            )
        );
        await nextTick();

        const secondMessage = mounted.result.sessionHistory.value[0];
        expect(secondMessage ? selectToolCalls(secondMessage)[0] : undefined).toMatchObject({
            status: 'executing',
        });
        expect(secondMessage ? selectToolCalls(secondMessage)[0]?.result : undefined).toContain(
            'stream-2'
        );

        mounted.unmount();
    });
});
