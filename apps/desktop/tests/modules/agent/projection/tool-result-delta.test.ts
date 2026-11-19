import { createAgentProjection } from '@tests/utils/agentProjection';
import { describe, expect, it, vi } from 'vitest';

import { selectToolCalls } from '@/app/api/agent/history';
import type { TaskViewSnapshot } from '@/modules/agent/contracts';

function createSnapshot(): TaskViewSnapshot {
    const now = Date.now();
    return {
        taskId: 'task-1',
        sessionId: null,
        turnId: null,
        status: 'running',
        executionMode: 'foreground',
        sessionHistory: [],
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

describe('user watches a tool call while it runs', () => {
    it('user sees the running tool call result updated in place', () => {
        const snapshot = createSnapshot();
        const publish = vi.fn();
        const projection = createAgentProjection(snapshot, publish);
        const startedAt = Date.now();

        projection.bootstrap([], 'run bash', undefined);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_start',
                callId: 'call-bash-1',
                toolName: 'Bash',
                namespacedName: 'builtin__bash',
                source: 'builtin',
                startedAt,
                sourceLabel: '内置工具',
                arguments: {
                    command: 'Write-Output "stream-1"',
                },
                builtinConversationSemantic: {
                    action: 'run',
                    target: 'Write-Output "stream-1"',
                },
            },
        });

        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'result_delta',
                callId: 'call-bash-1',
                result: [
                    'Shell: powershell',
                    'Working directory: D:\\Project\\TouchAI',
                    'Exit code: none',
                    'Duration: 500ms',
                    '',
                    'stream-1',
                ].join('\n'),
            } as never,
        });

        const assistantMessage = snapshot.sessionHistory.find(
            (message) => message.role === 'assistant'
        );
        const toolCalls = assistantMessage ? selectToolCalls(assistantMessage) : [];
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0]).toMatchObject({
            id: 'call-bash-1',
            status: 'executing',
            startedAt,
            result: [
                'Shell: powershell',
                'Working directory: D:\\Project\\TouchAI',
                'Exit code: none',
                'Duration: 500ms',
                '',
                'stream-1',
            ].join('\n'),
        });
    });
});
