import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';
import type { SessionMessage } from '@/types/session';

/**
 * Approvals and questions are the two moments where the task blocks on the user. A pending
 * approval that is not surfaced leaves the task silently waiting; one that is settled twice
 * resolves a promise the runtime already moved past.
 */
function createSnapshot(): SessionTaskSnapshot {
    return {
        taskId: 'task-1',
        sessionId: 1,
        turnId: null,
        status: 'running',
        executionMode: 'foreground',
        prompt: 'Prompt',
        sessionHistory: [],
        pendingToolApproval: null,
        pendingApprovals: [],
        pendingUserQuestion: null,
        error: null,
        currentModel: null,
        promptSnapshot: null,
        lastCheckpoint: null,
        startedAt: 1,
        updatedAt: 1,
        modelSwitchCount: 0,
    };
}

function createProjection() {
    const snapshot = createSnapshot();
    const publish = vi.fn();
    return { snapshot, publish, projection: new SessionTaskProjection(snapshot, publish) };
}

/** A projection that has bootstrapped and carries one tool call awaiting approval. */
function withToolCall() {
    const { snapshot, publish, projection } = createProjection();
    projection.bootstrap([], 'Hello', []);
    const assistant = snapshot.sessionHistory.find((m) => m.role === 'assistant') as SessionMessage;
    assistant.parts.push({
        type: 'tool_call',
        toolCall: {
            id: 'call-1',
            name: 'read_file',
            namespacedName: 'builtin__read_file',
            source: 'builtin',
            arguments: {},
            status: 'executing',
        },
    } as never);
    return { snapshot, publish, projection, assistant };
}

beforeEach(() => {
    setLocale('en-US');
    let uuidIndex = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
        () => `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, '0')}`
    );
});

/** A complete approval request, as the runtime builds it for the approval card. */
function approvalRequest(callId: string) {
    return {
        callId,
        title: 'Read a file',
        description: 'The tool wants to read a file',
        command: 'read_file a.txt',
        riskLabel: 'low',
        reason: 'reading is safe',
        commandLabel: 'Command',
        approveLabel: 'Approve',
        rejectLabel: 'Reject',
        enterHint: 'Enter to approve',
        escHint: 'Esc to reject',
    };
}

describe('user is asked to approve a tool call', () => {
    it('user gets the task paused while the approval is pending', async () => {
        const { snapshot, projection } = withToolCall();

        const promise = projection.requestToolApproval(approvalRequest('call-1'));

        // The task must not look like it is still working while it waits for the user.
        expect(snapshot.status).toBe('waiting_approval');
        expect(snapshot.pendingToolApproval).toMatchObject({ callId: 'call-1' });

        projection.approvePendingToolApproval('call-1');
        await promise;
    });

    it('user gets the tool call marked as awaiting approval', async () => {
        const { snapshot, projection, assistant } = withToolCall();

        const promise = projection.requestToolApproval(approvalRequest('call-1'));

        const part = assistant.parts.find((entry) => entry.type === 'tool_call') as never as {
            toolCall: { status: string };
        };
        expect(part.toolCall.status).toBe('awaiting_approval');

        projection.approvePendingToolApproval('call-1');
        await promise;
        expect(snapshot).toBeDefined();
    });

    it('user approves and the request resolves as allowed', async () => {
        const { projection } = withToolCall();
        const promise = projection.requestToolApproval(approvalRequest('call-1'));

        expect(projection.approvePendingToolApproval('call-1')).toBe(true);

        await expect(promise).resolves.toBe(true);
    });

    it('user rejects and the request resolves as refused', async () => {
        const { projection } = withToolCall();
        const promise = projection.requestToolApproval(approvalRequest('call-1'));

        expect(projection.rejectPendingToolApproval('call-1')).toBe(true);

        await expect(promise).resolves.toBe(false);
    });

    it('user approves without naming a call and the pending one is used', async () => {
        const { projection } = withToolCall();
        const promise = projection.requestToolApproval(approvalRequest('call-1'));

        // The runtime calls this without an id when there is only one approval waiting.
        expect(projection.approvePendingToolApproval()).toBe(true);

        await expect(promise).resolves.toBe(true);
    });

    it('user gets false when there is nothing waiting to approve', () => {
        const { projection } = createProjection();

        expect(projection.approvePendingToolApproval()).toBe(false);
        expect(projection.rejectPendingToolApproval()).toBe(false);
    });

    it('user gets the task running again once the approval is settled', async () => {
        const { snapshot, projection } = withToolCall();
        const promise = projection.requestToolApproval(approvalRequest('call-1'));
        expect(snapshot.status).toBe('waiting_approval');

        projection.approvePendingToolApproval('call-1');
        await promise;

        expect(snapshot.status).toBe('running');
        expect(snapshot.pendingToolApproval).toBeNull();
    });

    it('user gets no second approval accepted for a call already settled', async () => {
        const { projection } = withToolCall();
        const first = projection.requestToolApproval(approvalRequest('call-1'));
        projection.approvePendingToolApproval('call-1');
        await first;

        // A repeat request for the same call must not open a second pending approval; it either
        // resolves false or stays settled, but it must never resolve true.
        const second = projection.requestToolApproval(approvalRequest('call-1'));
        const outcome = await Promise.race([
            second.then((value) => value),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
        ]);
        expect(outcome).not.toBe(true);
    });

    it('user gets no approval request before a task started', async () => {
        const { projection } = createProjection();

        await expect(projection.requestToolApproval(approvalRequest('call-1'))).resolves.toBe(
            false
        );
    });

    it('user gets every pending approval cleared when the task is cancelled', async () => {
        const { snapshot, projection } = withToolCall();
        const promise = projection.requestToolApproval(approvalRequest('call-1'));

        projection.clearPendingApprovals();

        // A cancelled task must not leave the runtime waiting on an approval nobody will give.
        await expect(promise).resolves.toBe(false);
        expect(snapshot.pendingToolApproval).toBeNull();
    });
});

describe('user is asked a question by the model', () => {
    const questions = [
        {
            question: 'Which file?',
            header: 'File',
            options: [{ label: 'a.txt' }, { label: 'b.txt' }],
        },
    ];

    it('user gets the task paused while the question is pending', async () => {
        const { snapshot, projection } = withToolCall();

        const promise = projection.requestUserQuestions('call-1', questions as never);

        expect(snapshot.status).toBe('waiting_approval');
        expect(snapshot.pendingUserQuestion).toMatchObject({ callId: 'call-1' });

        projection.settleUserQuestion('call-1', [{ answers: ['a.txt'] } as never]);
        await promise;
    });

    it('user answers and the answers reach the caller', async () => {
        const { projection } = withToolCall();
        const promise = projection.requestUserQuestions('call-1', questions as never);

        const answers = [{ answers: ['a.txt'] } as never];
        expect(projection.settleUserQuestion('call-1', answers)).toBe(true);

        await expect(promise).resolves.toEqual(answers);
    });

    it('user dismisses the question and the caller gets null', async () => {
        const { projection } = withToolCall();
        const promise = projection.requestUserQuestions('call-1', questions as never);

        // Dismissing is not the same as answering; the caller has to tell them apart.
        expect(projection.settleUserQuestion('call-1', null)).toBe(true);

        await expect(promise).resolves.toBeNull();
    });

    it('user gets false when settling a question that is not pending', () => {
        const { projection } = createProjection();

        expect(projection.settleUserQuestion('missing', null)).toBe(false);
    });

    it('user gets no question asked before a task started', async () => {
        const { projection } = createProjection();

        await expect(
            projection.requestUserQuestions('call-1', questions as never)
        ).resolves.toBeNull();
    });

    it('user gets the pending question readable while it waits', () => {
        const { projection } = withToolCall();
        const promise = projection.requestUserQuestions('call-1', questions as never);

        expect(projection.getPendingUserQuestion()).toMatchObject({ callId: 'call-1' });

        projection.settleUserQuestion('call-1', null);
        void promise;
    });
});
