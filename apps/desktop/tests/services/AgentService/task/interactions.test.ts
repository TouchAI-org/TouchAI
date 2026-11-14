import { describe, expect, it, vi } from 'vitest';

import {
    type PendingUserQuestion,
    TaskInteractions,
} from '@/services/AgentService/task/interactions';
import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { TaskViewSnapshot } from '@/services/AgentService/task/types';
import type { PendingToolApproval } from '@/types/session';

function approval(callId: string): PendingToolApproval {
    return {
        callId,
        messageId: 'message-1',
        title: 'Confirm',
        description: 'Run a command',
        command: 'echo hi',
        riskLabel: 'High risk',
        reason: 'It changes state',
        approveLabel: 'Approve',
        rejectLabel: 'Reject',
        enterHint: 'Enter',
        escHint: 'Esc',
        keyboardApproveAt: 1,
    };
}

describe('user waits for an approval decision', () => {
    it('user is not asked twice and both waiters settle for a repeated call', async () => {
        const interactions = new TaskInteractions();
        interactions.beginAttempt('attempt-1');
        const display = approval('call-1');
        const first = interactions.registerApproval(display, 'attempt-1');
        const second = interactions.registerApproval(display, 'attempt-1');

        interactions.settleApproval('call-1', true, display.decisionId);

        await expect(first).resolves.toBe(true);
        await expect(second).resolves.toBe(true);
    });

    it('user cannot re-decide a call that was already settled', () => {
        const interactions = new TaskInteractions();
        interactions.beginAttempt('attempt-1');
        const display = approval('call-1');
        void interactions.registerApproval(display, 'attempt-1');

        expect(interactions.settleApproval('call-1', true, display.decisionId)).not.toBeNull();
        expect(interactions.settleApproval('call-1', false, display.decisionId)).toBeNull();
        expect(interactions.settleApproval('missing', true, display.decisionId)).toBeNull();
    });

    it('user decision without an identity is rejected instead of settling', async () => {
        const interactions = new TaskInteractions();
        interactions.beginAttempt('attempt-1');
        const display = approval('call-1');
        const wait = interactions.registerApproval(display, 'attempt-1');

        expect(interactions.settleApproval('call-1', true, undefined)).toBeNull();
        expect(interactions.pendingApproval?.callId).toBe('call-1');

        interactions.settleApproval('call-1', false, display.decisionId);
        await expect(wait).resolves.toBe(false);
    });

    it('user decision with a foreign identity is rejected', async () => {
        const interactions = new TaskInteractions();
        interactions.beginAttempt('attempt-1');
        const display = approval('call-1');
        const wait = interactions.registerApproval(display, 'attempt-1');

        expect(interactions.settleApproval('call-1', true, 'task:0:other:1')).toBeNull();
        expect(interactions.pendingApproval?.callId).toBe('call-1');

        interactions.settleApproval('call-1', true, display.decisionId);
        await expect(wait).resolves.toBe(true);
    });

    it('user wait is released when the lifecycle generation advances', async () => {
        const interactions = new TaskInteractions();
        interactions.beginAttempt('attempt-1');
        const wait = interactions.registerApproval(approval('call-1'), 'attempt-1');

        interactions.beginAttempt('attempt-2');

        await expect(wait).resolves.toBe(false);
        expect(interactions.pendingApproval).toBeNull();
    });

    it('user registration from a stale attempt token is refused, not registered as new', async () => {
        const interactions = new TaskInteractions();
        interactions.beginAttempt('attempt-1');
        interactions.beginAttempt('attempt-2');

        const wait = interactions.registerApproval(approval('call-1'), 'attempt-1');

        await expect(wait).resolves.toBe(false);
        expect(interactions.pendingApproval).toBeNull();
    });

    it('user deciding a reused callId with a stale identity is rejected', async () => {
        const interactions = new TaskInteractions();

        interactions.beginAttempt('attempt-1');
        const staleDisplay = approval('call-1');
        void interactions.registerApproval(staleDisplay, 'attempt-1');

        interactions.beginAttempt('attempt-2');
        const liveDisplay = approval('call-1');
        const live = interactions.registerApproval(liveDisplay, 'attempt-2');

        expect(interactions.settleApproval('call-1', true, staleDisplay.decisionId)).toBeNull();
        expect(interactions.pendingApproval?.callId).toBe('call-1');

        expect(interactions.settleApproval('call-1', true, liveDisplay.decisionId)).not.toBeNull();
        await expect(live).resolves.toBe(true);
    });

    it('user wait is released when the task is cancelled', async () => {
        const interactions = new TaskInteractions();
        interactions.beginAttempt('attempt-1');
        const approvalWait = interactions.registerApproval(approval('call-1'), 'attempt-1');
        const questionWait = interactions.registerQuestion(
            {
                callId: 'q-1',
                sourceMessageId: 'message-1',
                questions: [],
                createdAt: 1,
            },
            'attempt-1'
        );

        interactions.cancelAll();

        await expect(approvalWait).resolves.toBe(false);
        await expect(questionWait).resolves.toBeNull();
        expect(interactions.hasPending).toBe(false);
    });

    it('user registration after the task ended is settled immediately instead of hanging', async () => {
        const interactions = new TaskInteractions();
        interactions.beginAttempt('attempt-1');
        interactions.cancelAll();

        await expect(interactions.registerApproval(approval('late'), 'attempt-1')).resolves.toBe(
            false
        );
        await expect(
            interactions.registerQuestion(
                {
                    callId: 'late-q',
                    sourceMessageId: '',
                    questions: [],
                    createdAt: 1,
                },
                'attempt-1'
            )
        ).resolves.toBeNull();
        expect(interactions.hasPending).toBe(false);
    });

    it('user sees an untokened registration refused before and after an attempt opens', async () => {
        const interactions = new TaskInteractions();
        expect(interactions.acceptsRegistration()).toBe(false);
        expect(interactions.acceptsRegistration('')).toBe(false);
        await expect(interactions.registerApproval(approval('early'))).resolves.toBe(false);

        interactions.beginAttempt('attempt-1');

        expect(interactions.acceptsRegistration()).toBe(false);
        expect(interactions.acceptsRegistration('')).toBe(false);
        await expect(interactions.registerApproval(approval('late'))).resolves.toBe(false);
        expect(interactions.pendingApproval).toBeNull();
    });

    it('user answering a reused question with a stale identity is rejected', () => {
        const interactions = new TaskInteractions();
        interactions.beginAttempt('attempt-1');
        const stale: PendingUserQuestion = {
            callId: 'q-1',
            sourceMessageId: '',
            questions: [],
            createdAt: 1,
        };
        void interactions.registerQuestion(stale, 'attempt-1');

        interactions.beginAttempt('attempt-2');
        const live: PendingUserQuestion = {
            callId: 'q-1',
            sourceMessageId: '',
            questions: [],
            createdAt: 2,
        };
        void interactions.registerQuestion(live, 'attempt-2');

        expect(interactions.settleQuestion('q-1', null, stale.decisionId)).toBe(false);
        expect(interactions.settleQuestion('q-1', null, live.decisionId)).toBe(true);
    });

    it('user registration from a failed attempt is refused during the retry gap', async () => {
        const interactions = new TaskInteractions();
        interactions.beginAttempt('attempt-1');
        // The attempt fails; the runtime closes its window before the retry delay.
        interactions.endAttempt();

        // A late tool callback from the failed attempt must not register...
        await expect(interactions.registerApproval(approval('late'), 'attempt-1')).resolves.toBe(
            false
        );
        expect(interactions.pendingApproval).toBeNull();
        // ...and the task itself is not permanently closed.
        expect(interactions.isClosed).toBe(false);
    });

    it('user wait is released when its attempt ends and the next attempt can register again', async () => {
        const interactions = new TaskInteractions();
        interactions.beginAttempt('attempt-1');
        const wait = interactions.registerApproval(approval('call-1'), 'attempt-1');

        interactions.endAttempt();
        await expect(wait).resolves.toBe(false);

        interactions.beginAttempt('attempt-2');
        const live = interactions.registerApproval(approval('call-2'), 'attempt-2');
        expect(interactions.pendingApproval?.callId).toBe('call-2');
        expect(interactions.acceptsRegistration('attempt-1')).toBe(false);
        expect(interactions.acceptsRegistration('attempt-2')).toBe(true);

        interactions.settleApproval('call-2', true, interactions.pendingApproval!.decisionId);
        await expect(live).resolves.toBe(true);
    });
});

function createSnapshot(): TaskViewSnapshot {
    return {
        taskId: 'task-1',
        sessionId: 1,
        turnId: null,
        status: 'running',
        executionMode: 'foreground',
        sessionHistory: [],
        pendingUserMessages: [],
        pendingToolApproval: null,
        pendingApprovals: [],
        pendingUserQuestion: null,
        error: null,
        currentModel: null,
        startedAt: 1,
        updatedAt: 1,
        modelSwitchCount: 0,
    };
}

describe('user approves a tool while no assistant message is visible yet', () => {
    it('user can still wait and settle the approval through the task interactions', async () => {
        const snapshot = createSnapshot();
        const interactions = new TaskInteractions('task-1');
        interactions.beginAttempt('attempt-1');
        const projection = new SessionTaskProjection(snapshot, vi.fn(), interactions);

        // No bootstrap, so there is no active assistant message to attach a card to.
        expect(projection.getActiveAssistantMessageId()).toBeNull();

        const payload = { callId: 'call-late', command: 'echo hi' } as never;
        const display = projection.formatApproval(payload);
        const wait = interactions.registerApproval(display, 'attempt-1');
        projection.renderApproval(display, payload);

        expect(snapshot.pendingApprovals.map((item) => item.callId)).toEqual(['call-late']);
        expect(interactions.pendingApproval?.decisionId).toBe(display.decisionId);

        const settled = projection.settleInteractionApproval('call-late', true, {
            decisionId: display.decisionId,
        });

        expect(settled).toBe(true);
        await expect(wait).resolves.toBe(true);
        expect(snapshot.pendingApprovals).toEqual([]);
    });

    it('user cancelling the task rejects the wait instead of hanging it', async () => {
        const snapshot = createSnapshot();
        const interactions = new TaskInteractions('task-1');
        interactions.beginAttempt('attempt-1');
        const projection = new SessionTaskProjection(snapshot, vi.fn(), interactions);

        const payload = { callId: 'call-cancel', command: 'echo hi' } as never;
        const display = projection.formatApproval(payload);
        const wait = interactions.registerApproval(display, 'attempt-1');
        projection.renderApproval(display, payload);

        projection.clearPendingApprovals();

        await expect(wait).resolves.toBe(false);
        expect(snapshot.pendingApprovals).toEqual([]);
    });
});
