import { describe, expect, it, vi } from 'vitest';

import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';
import { selectToolCalls } from '@/utils/session';

function createSnapshot(): SessionTaskSnapshot {
    const now = Date.now();
    return {
        taskId: 'task-1',
        sessionId: null,
        turnId: null,
        status: 'running',
        executionMode: 'foreground',
        prompt: 'run bash',
        sessionHistory: [],
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

describe('user watches a tool call while it runs', () => {
    it('user sees the running tool call result updated in place', () => {
        const snapshot = createSnapshot();
        const publish = vi.fn();
        const projection = new SessionTaskProjection(snapshot, publish);
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
