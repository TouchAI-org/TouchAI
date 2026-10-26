import { mountComposable } from '@tests/utils/composables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { useAgentState } from '@/composables/agent/useAgentState';
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
        prompt: 'run bash',
        sessionHistory: [createAssistantMessage(toolCall)],
        pendingToolApproval: null,
        pendingApprovals: [],
        pendingUserQuestion: null,
        error: null,
        currentModel: null,
        promptSnapshot: null,
        lastCheckpoint: null,
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

describe('when the user clears the conversation', () => {
    it('user gets the answer, reasoning and error wiped from the page', async () => {
        subscribeTaskMock.mockReturnValue(() => undefined);
        const mounted = await mountComposable(() => useAgentState({}));

        mounted.result.response.value = 'an answer';
        mounted.result.reasoning.value = 'some thinking';
        mounted.result.error.value = new Error('boom') as never;

        mounted.result.resetTaskViewState();
        await nextTick();

        // Clearing must not leave the previous answer on screen under the new conversation.
        expect(mounted.result.response.value).toBe('');
        expect(mounted.result.reasoning.value).toBe('');
        expect(mounted.result.error.value).toBeNull();

        mounted.unmount();
    });
});
