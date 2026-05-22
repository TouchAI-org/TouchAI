import { describe, expect, it } from 'vitest';

import { SessionTaskProjection } from '@/services/AgentService/task/projection';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';

const WAITING_APPROVAL_TEXT = '\u4efb\u52a1\u6b63\u5728\u7b49\u5f85\u6279\u51c6';
const COMPLETED_TEXT = '\u4efb\u52a1\u5df2\u5b8c\u6210';
const FAILED_TEXT = '\u4efb\u52a1\u5931\u8d25\uff1anetwork error';

function createSnapshot(): SessionTaskSnapshot {
    return {
        taskId: 'task-1',
        sessionId: 1,
        turnId: 1,
        status: 'running',
        executionMode: 'foreground',
        prompt: 'hello',
        sessionHistory: [],
        pendingToolApproval: null,
        pendingApprovals: [],
        error: null,
        currentModel: null,
        promptSnapshot: null,
        lastCheckpoint: null,
        startedAt: 1,
        updatedAt: 1,
        modelSwitchCount: 0,
    };
}

describe('SessionTaskProjection status reminders', () => {
    it('inserts a system reminder when the task starts waiting for approval', async () => {
        const snapshot = createSnapshot();
        const projection = new SessionTaskProjection(snapshot, () => undefined);

        projection.bootstrap([], 'hello', []);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_start',
                callId: 'call-1',
                toolName: 'Shell',
                namespacedName: 'mcp__1__shell',
                source: 'mcp',
                serverId: 1,
                arguments: {},
            },
        });

        const approvalPromise = projection.requestToolApproval({
            callId: 'call-1',
            title: 'Approval required',
            description: 'Confirm the command.',
            command: 'echo hello',
            riskLabel: 'medium',
            reason: 'Needs confirmation before execution.',
            commandLabel: 'Command',
            approveLabel: 'Approve',
            rejectLabel: 'Reject',
            enterHint: 'Enter to approve',
            escHint: 'Esc to reject',
        });

        expect(snapshot.status).toBe('waiting_approval');
        expect(snapshot.sessionHistory[snapshot.sessionHistory.length - 1]).toMatchObject({
            role: 'system',
            content: WAITING_APPROVAL_TEXT,
        });

        projection.rejectPendingToolApproval('call-1');
        await approvalPromise;
    });

    it('inserts a system reminder when the task completes', () => {
        const snapshot = createSnapshot();
        const projection = new SessionTaskProjection(snapshot, () => undefined);

        projection.bootstrap([], 'hello', []);
        projection.handleChunk({
            content: 'done',
            done: false,
        });

        projection.markCompleted();

        expect(snapshot.status).toBe('completed');
        expect(snapshot.sessionHistory[snapshot.sessionHistory.length - 1]).toMatchObject({
            role: 'system',
            content: COMPLETED_TEXT,
        });
    });

    it('inserts a system reminder when the task fails', () => {
        const snapshot = createSnapshot();
        const projection = new SessionTaskProjection(snapshot, () => undefined);

        projection.bootstrap([], 'hello', []);
        projection.markFailed('network error');

        expect(snapshot.status).toBe('failed');
        expect(
            snapshot.sessionHistory.some(
                (message) => message.role === 'system' && message.content === FAILED_TEXT
            )
        ).toBe(true);
    });
});
