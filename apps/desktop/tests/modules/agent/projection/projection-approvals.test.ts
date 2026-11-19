import { createAgentProjection } from '@tests/utils/agentProjection';
import { beforeEach, describe, expect, it } from 'vitest';

import { selectToolCalls } from '@/app/api/agent/history';
import { setLocale } from '@/i18n';
import type { TaskViewSnapshot, ToolApprovalDecisionRequest } from '@/modules/agent/contracts';

function fixture(visible = true) {
    const snapshot: TaskViewSnapshot = {
        taskId: 'task-1',
        sessionId: 1,
        turnId: null,
        status: 'running',
        executionMode: 'foreground',
        sessionHistory: [],
        pendingApprovals: [],
        pendingToolApproval: null,
        pendingUserQuestion: null,
        error: null,
        currentModel: null,
        startedAt: 1,
        updatedAt: 1,
        modelSwitchCount: 0,
    };
    const projection = createAgentProjection(snapshot, () => {});
    if (visible) {
        projection.bootstrap([], 'Read a file', []);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_start',
                callId: 'call-1',
                toolName: 'Read',
                namespacedName: 'builtin__read',
                source: 'builtin',
                arguments: { path: 'fixture.txt' },
            },
        });
    }
    const request: ToolApprovalDecisionRequest = {
        callId: 'call-1',
        title: 'Read a file',
        description: '',
        command: 'fixture.txt',
        riskLabel: '',
        reason: '',
        commandLabel: '',
        approveLabel: 'Approve',
        rejectLabel: 'Reject',
        enterHint: 'Enter',
        escHint: 'Esc',
    };
    const approval = (decisionId = 'live-approval') => {
        const display = projection.formatApproval(request);
        display.decisionId = decisionId;
        projection.observeApproval(display, request);
        return display;
    };
    const question = (decisionId = 'live-question') =>
        projection.observeQuestion({
            callId: 'call-1',
            decisionId,
            sourceMessageId: projection.getActiveAssistantMessageId() ?? '',
            createdAt: 1,
            questions: [
                {
                    question: 'Which file?',
                    header: 'File',
                    options: [{ label: 'First' }, { label: 'Second' }],
                },
            ],
        });
    return { snapshot, projection, approval, question };
}

beforeEach(() => setLocale('en-US'));

describe('given a projection observes identities issued by the task owner', () => {
    it('user sees the pending approval and matching tool card without creating another wait', () => {
        const { snapshot, approval } = fixture();
        approval();
        expect(snapshot).toMatchObject({
            status: 'waiting_approval',
            pendingToolApproval: {
                callId: 'call-1',
                decisionId: 'live-approval',
            },
        });
        expect(selectToolCalls(snapshot.sessionHistory[1]!)[0]?.status).toBe('awaiting_approval');
        expect(snapshot.sessionHistory[1]?.approvals?.[0]?.status).toBe('pending');
    });

    it('user sees the approved call resume and the temporary approval card disappear', () => {
        const { snapshot, projection, approval } = fixture();
        approval();
        projection.observeResolution('live-approval', true);
        expect(snapshot).toMatchObject({
            status: 'running',
            pendingApprovals: [],
            pendingToolApproval: null,
        });
        expect(selectToolCalls(snapshot.sessionHistory[1]!)[0]?.status).toBe('executing');
        expect(snapshot.sessionHistory[1]?.approvals).toEqual([]);
    });

    it('user sees a refused call retain its rejection reason rather than appear as a cancelled effect', () => {
        const { snapshot, projection, approval } = fixture();
        approval();
        projection.observeResolution('live-approval', false);
        expect(snapshot.status).toBe('running');
        expect(snapshot.pendingApprovals).toEqual([]);
        expect(selectToolCalls(snapshot.sessionHistory[1]!)[0]).toMatchObject({
            status: 'rejected',
            isError: true,
        });
        expect(snapshot.sessionHistory[1]?.approvals?.[0]).toMatchObject({
            status: 'rejected',
            resolutionText: '已拒绝执行此命令',
        });
    });

    it('user keeps the live approval when an older identity or an untrusted display echo arrives', () => {
        const { snapshot, projection, approval } = fixture();
        approval();
        projection.observeResolution('old-approval', true);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'approval_resolved',
                callId: 'call-1',
                approved: true,
            },
        });
        expect(snapshot.pendingToolApproval?.decisionId).toBe('live-approval');
        expect(snapshot.sessionHistory[1]?.approvals?.[0]?.status).toBe('pending');
        projection.observeResolution('live-approval', true);
        projection.observeResolution('live-approval', false);
        expect(selectToolCalls(snapshot.sessionHistory[1]!)[0]?.status).toBe('executing');
    });

    it('user sees one card when the same pending decision is observed twice', () => {
        const { snapshot, approval } = fixture();
        approval();
        approval();
        expect(snapshot.pendingApprovals).toHaveLength(1);
        expect(snapshot.sessionHistory[1]?.approvals).toHaveLength(1);
        expect(
            snapshot.sessionHistory[1]?.parts.filter((part) => part.type === 'approval')
        ).toHaveLength(1);
    });

    it('user can observe and clear a pending decision before an assistant message becomes visible', () => {
        const { snapshot, projection, approval } = fixture(false);
        approval();
        expect(snapshot.pendingToolApproval?.decisionId).toBe('live-approval');
        expect(snapshot.sessionHistory).toEqual([]);
        projection.observeResolution('live-approval', false);
        expect(snapshot.pendingToolApproval).toBeNull();
        expect(snapshot.status).toBe('running');
    });

    it('user sees every pending approval and question cleared when the task owner closes its attempt', () => {
        const { snapshot, projection, approval, question } = fixture();
        approval();
        question();
        projection.clearPendingApprovals();
        expect(snapshot).toMatchObject({
            pendingApprovals: [],
            pendingToolApproval: null,
            pendingUserQuestion: null,
        });
        expect(selectToolCalls(snapshot.sessionHistory[1]!)[0]).toMatchObject({
            status: 'cancelled',
            isError: false,
        });
        expect(snapshot.sessionHistory[1]?.approvals?.[0]).toMatchObject({
            status: 'cancelled',
            resolutionText: 'Request cancelled',
        });
    });

    it('user sees the pending question with its choices and returns to running after the owner records an answer', () => {
        const { snapshot, projection, question } = fixture();
        question();
        expect(snapshot).toMatchObject({
            status: 'waiting_approval',
            pendingUserQuestion: {
                decisionId: 'live-question',
                questions: [
                    { question: 'Which file?', options: [{ label: 'First' }, { label: 'Second' }] },
                ],
            },
        });
        projection.observeResolution('old-question', null);
        expect(snapshot.pendingUserQuestion?.decisionId).toBe('live-question');
        projection.observeResolution('live-question', null);
        expect(snapshot.pendingUserQuestion).toBeNull();
        expect(snapshot.status).toBe('running');
    });
});
