import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAskUser } from '@/composables/useAskUser';
import type { AskUserQuestion } from '@/services/AgentService/contracts/tooling';
import { useAskUserStore } from '@/stores/askUser';

function createApprovalPayload(callId: string, overrides: Record<string, unknown> = {}) {
    return {
        callId,
        title: 'Run shell command',
        command: 'rm -rf build',
        approveLabel: 'Run',
        rejectLabel: 'Cancel',
        ...overrides,
    } as never;
}

const question: AskUserQuestion = {
    question: 'Which environment should be deployed?',
    options: [{ label: 'Staging', description: 'Safe first' }, { label: 'Production' }],
} as never;

describe('when a tool asks the user to approve a command', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    it('user sees the approval request queued and nobody has answered it yet', async () => {
        const store = useAskUserStore();
        const decision = store.enqueueApproval(createApprovalPayload('call-1'), vi.fn());

        expect(decision).toEqual(expect.any(String));
        expect(store.hasPending).toBe(true);
        expect(store.current?.kind).toBe('approval');
        expect(store.pendingApprovalCallIds).toEqual(new Set(['call-1']));
    });

    it('user gets the tool run when approving the waiting command', async () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueApproval(createApprovalPayload('call-1'), resolve);

        expect(store.approveCurrentApproval()).toBe(true);

        expect(resolve).toHaveBeenCalledWith(true);
        expect(store.hasPending).toBe(false);
        expect(store.current).toBeNull();
    });

    it('user gets the tool stopped when rejecting the waiting command', async () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueApproval(createApprovalPayload('call-1'), resolve);

        expect(store.rejectCurrentApproval()).toBe(true);

        expect(resolve).toHaveBeenCalledWith(false);
        expect(store.hasPending).toBe(false);
    });

    it('user cannot approve a request that is not an approval prompt', async () => {
        const store = useAskUserStore();
        store.enqueueConfirm({ message: 'Delete this conversation?' }, vi.fn());

        expect(store.approveCurrentApproval()).toBe(false);
        expect(store.rejectCurrentApproval()).toBe(false);
        expect(store.hasPending).toBe(true);
    });

    it('user gets a duplicate request for the same call answered once and shared', async () => {
        const store = useAskUserStore();
        const first = vi.fn();
        const second = vi.fn();

        const firstId = store.enqueueApproval(createApprovalPayload('call-1'), first);
        const secondId = store.enqueueApproval(createApprovalPayload('call-1'), second);

        expect(secondId).toBe(firstId);
        expect(store.queue).toHaveLength(1);

        store.approveCurrentApproval();

        expect(first).toHaveBeenCalledWith(true);
        expect(second).toHaveBeenCalledWith(true);
    });

    it('user gets the approval resolved by its call id even when it is not the first in the queue', async () => {
        const store = useAskUserStore();
        const firstResolve = vi.fn();
        const secondResolve = vi.fn();
        store.enqueueApproval(createApprovalPayload('call-1'), firstResolve);
        store.enqueueApproval(createApprovalPayload('call-2'), secondResolve);

        expect(store.resolveApprovalByCallId('call-2', true)).toBe(true);

        expect(secondResolve).toHaveBeenCalledWith(true, undefined);
        expect(firstResolve).not.toHaveBeenCalled();
        expect(store.pendingApprovalCallIds).toEqual(new Set(['call-1']));
    });

    it('user gets the reason attached when the approval is cancelled from outside', () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueApproval(createApprovalPayload('call-1'), resolve);

        expect(store.cancelByApprovalCallId('call-1', 'turn cancelled')).toBe(true);

        expect(resolve).toHaveBeenCalledWith(false, 'turn cancelled');
        expect(store.hasPending).toBe(false);
    });

    it('user gets no change when cancelling an approval that is not waiting', () => {
        const store = useAskUserStore();

        expect(store.cancelByApprovalCallId('missing')).toBe(false);
        expect(store.resolveApprovalByCallId('missing', true)).toBe(false);
        expect(store.hasPending).toBe(false);
    });
});

describe('when the app asks the user to confirm an action', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    it('user gets the action confirmed when accepting', () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueConfirm({ message: 'Delete this conversation?' }, resolve);

        expect(store.confirmCurrentConfirm()).toBe(true);

        expect(resolve).toHaveBeenCalledWith(true);
        expect(store.hasPending).toBe(false);
    });

    it('user gets the action dropped when declining', () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueConfirm({ message: 'Delete this conversation?' }, resolve);

        expect(store.cancelCurrentConfirm()).toBe(true);

        expect(resolve).toHaveBeenCalledWith(false);
        expect(store.hasPending).toBe(false);
    });

    it('user cannot confirm an approval prompt as if it were a confirmation', () => {
        const store = useAskUserStore();
        store.enqueueApproval(createApprovalPayload('call-1'), vi.fn());

        expect(store.confirmCurrentConfirm()).toBe(false);
        expect(store.cancelCurrentConfirm()).toBe(false);
        expect(store.hasPending).toBe(true);
    });
});

describe('when the assistant asks the user a question', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    it('user gets the picked answers delivered back to the assistant', () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueQuestion([question], resolve, { sourceCallId: 'call-q' });
        const answers = [{ questionIndex: 0, selectedLabels: ['Staging'], skipped: false }];

        expect(store.answerCurrentQuestion(answers)).toBe(true);

        expect(resolve).toHaveBeenCalledWith(answers);
        expect(store.hasPending).toBe(false);
    });

    it('user gets a skipped question reported as no answer at all', () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueQuestion([question], resolve);

        expect(store.cancelCurrentQuestion()).toBe(true);

        expect(resolve).toHaveBeenCalledWith(null);
    });

    it('user gets the question dropped when its tool call is cancelled', () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueQuestion([question], resolve, { sourceCallId: 'call-q' });

        expect(store.cancelByQuestionCallId('call-q')).toBe(true);

        expect(resolve).toHaveBeenCalledWith(null);
        expect(store.hasPending).toBe(false);
    });

    it('user gets no change when cancelling a question that is not waiting', () => {
        const store = useAskUserStore();

        expect(store.cancelByQuestionCallId('missing')).toBe(false);
        expect(store.answerCurrentQuestion([])).toBe(false);
    });

    it('user cannot answer a question prompt that is not on screen yet', () => {
        const store = useAskUserStore();
        store.enqueueApproval(createApprovalPayload('call-1'), vi.fn());

        expect(store.answerCurrentQuestion([])).toBe(false);
        expect(store.cancelCurrentQuestion()).toBe(false);
    });
});

describe('when the search window closes with prompts still waiting', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    it('user gets every waiting prompt dismissed so nothing stays stuck behind a hidden window', () => {
        const store = useAskUserStore();
        const approvalResolve = vi.fn();
        const confirmResolve = vi.fn();
        const questionResolve = vi.fn();

        store.enqueueApproval(createApprovalPayload('call-1'), approvalResolve);
        store.enqueueConfirm({ message: 'Keep editing?' }, confirmResolve);
        store.enqueueQuestion([question], questionResolve);

        store.clearAll('window hidden');

        expect(store.hasPending).toBe(false);
        expect(store.queue).toEqual([]);
        expect(approvalResolve).toHaveBeenCalledWith(false, 'window hidden');
        expect(confirmResolve).toHaveBeenCalledWith(false);
        expect(questionResolve).toHaveBeenCalledWith(null);
    });

    it('user gets the next queued prompt shown after the first one is answered', () => {
        const store = useAskUserStore();
        store.enqueueApproval(createApprovalPayload('call-1'), vi.fn());
        store.enqueueConfirm({ message: 'Keep editing?' }, vi.fn());

        expect(store.current?.kind).toBe('approval');

        store.approveCurrentApproval();

        expect(store.current?.kind).toBe('confirm');
        expect(store.hasPending).toBe(true);
    });
});

describe('when a tool call asks the user through the shared helper', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    it('user gets the approval answer delivered as a resolved promise', async () => {
        const { requestApproval } = useAskUser();
        const store = useAskUserStore();

        const answer = requestApproval(createApprovalPayload('call-1'));
        expect(store.hasPending).toBe(true);

        store.approveCurrentApproval();

        await expect(answer).resolves.toBe(true);
    });

    it('user gets a rejection delivered as a resolved false instead of a thrown error', async () => {
        const { requestApproval } = useAskUser();
        const store = useAskUserStore();

        const answer = requestApproval(createApprovalPayload('call-1'));
        store.rejectCurrentApproval();

        await expect(answer).resolves.toBe(false);
    });

    it('user gets the confirmation answer delivered as a resolved promise', async () => {
        const { requestConfirm } = useAskUser();
        const store = useAskUserStore();

        const answer = requestConfirm({ message: 'Delete this conversation?' });
        store.confirmCurrentConfirm();

        await expect(answer).resolves.toBe(true);
    });

    it('user gets the picked answers delivered for a question', async () => {
        const { requestQuestion } = useAskUser();
        const store = useAskUserStore();
        const answers = [{ questionIndex: 0, selectedLabels: ['Staging'], skipped: false }];

        const answer = requestQuestion([question], { sourceCallId: 'call-q' });
        store.answerCurrentQuestion(answers);

        await expect(answer).resolves.toEqual(answers);
    });

    it('user gets a null answer when the question is cancelled', async () => {
        const { requestQuestion } = useAskUser();
        const store = useAskUserStore();

        const answer = requestQuestion([question]);
        store.cancelCurrentQuestion();

        await expect(answer).resolves.toBeNull();
    });
});
