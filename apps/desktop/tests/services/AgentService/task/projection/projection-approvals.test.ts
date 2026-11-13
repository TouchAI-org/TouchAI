import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import type { AskUserQuestion } from '@/services/AgentService/contracts/tooling';
import {
    type PendingUserQuestion,
    TaskInteractions,
} from '@/services/AgentService/task/interactions';
import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { TaskViewSnapshot } from '@/services/AgentService/task/types';
import type { SessionMessage } from '@/types/session';

/**
 * Approvals and questions are owned by `TaskInteractions`; the projection only
 * renders their public state. These tests exercise the same sequence the task
 * center uses so a regression in registration, rendering or settlement is
 * visible without reintroducing approval state into the projection itself.
 */
function createSnapshot(): TaskViewSnapshot {
    return {
        taskId: 'task-1',
        sessionId: 1,
        turnId: null,
        status: 'running',
        executionMode: 'foreground',
        sessionHistory: [],
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

function createProjection() {
    const snapshot = createSnapshot();
    const interactions = new TaskInteractions('task-1');
    interactions.beginAttempt('attempt-1');
    const publish = vi.fn();
    const projection = new SessionTaskProjection(snapshot, publish, interactions);
    return { snapshot, interactions, publish, projection };
}

/** A projection that has bootstrapped and carries one tool call awaiting approval. */
function withToolCall() {
    const state = createProjection();
    state.projection.bootstrap([], 'Hello', []);
    const assistant = state.snapshot.sessionHistory.find(
        (message) => message.role === 'assistant'
    ) as SessionMessage;
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
    return { ...state, assistant };
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
        attemptToken: 'attempt-1',
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

function requestApproval(state: ReturnType<typeof withToolCall>, callId = 'call-1') {
    const payload = approvalRequest(callId);
    const display = state.projection.formatApproval(payload);
    const wait = state.interactions.registerApproval(display, payload.attemptToken);
    state.projection.renderApproval(display, payload);
    return { display, payload, wait };
}

function question(callId: string, questions: AskUserQuestion[]): PendingUserQuestion {
    return {
        callId,
        sourceMessageId: 'message-1',
        questions,
        createdAt: Date.now(),
    };
}

function requestQuestion(state: ReturnType<typeof withToolCall>, callId = 'call-1') {
    const record = question(callId, [
        {
            question: 'Which file?',
            header: 'File',
            options: [{ label: 'a.txt' }, { label: 'b.txt' }],
        },
    ]);
    record.sourceMessageId = state.projection.getActiveAssistantMessageId() ?? '';
    const wait = state.interactions.registerQuestion(record, 'attempt-1');
    state.projection.renderQuestion(record);
    return { record, wait };
}

describe('user is asked to approve a tool call', () => {
    it('user gets the task paused while the approval is pending', () => {
        const state = withToolCall();
        const { wait } = requestApproval(state);

        expect(state.snapshot.status).toBe('waiting_approval');
        expect(state.snapshot.pendingToolApproval).toMatchObject({ callId: 'call-1' });

        const settled = state.projection.settleInteractionApproval('call-1', true, {
            decisionId: state.snapshot.pendingToolApproval?.decisionId,
        });
        expect(settled).toBe(true);
        return expect(wait).resolves.toBe(true);
    });

    it('user gets the tool call marked as awaiting approval', () => {
        const state = withToolCall();
        const { wait } = requestApproval(state);

        const part = state.assistant.parts.find((entry) => entry.type === 'tool_call');
        expect(part).toMatchObject({ toolCall: { status: 'awaiting_approval' } });

        state.projection.settleInteractionApproval('call-1', true, {
            decisionId: state.snapshot.pendingToolApproval?.decisionId,
        });
        return expect(wait).resolves.toBe(true);
    });

    it('user approves and the request resolves as allowed', async () => {
        const state = withToolCall();
        const { display, wait } = requestApproval(state);

        expect(
            state.projection.settleInteractionApproval('call-1', true, {
                decisionId: display.decisionId,
            })
        ).toBe(true);

        await expect(wait).resolves.toBe(true);
    });

    it('user rejects and the request resolves as refused', async () => {
        const state = withToolCall();
        const { display, wait } = requestApproval(state);

        expect(
            state.projection.settleInteractionApproval('call-1', false, {
                decisionId: display.decisionId,
            })
        ).toBe(true);

        await expect(wait).resolves.toBe(false);
    });

    it('user decision without an identity is refused and the task keeps waiting', async () => {
        const state = withToolCall();
        const { display, wait } = requestApproval(state);

        expect(state.projection.settleInteractionApproval('call-1', true)).toBe(false);
        expect(state.snapshot.pendingToolApproval?.callId).toBe('call-1');

        state.projection.settleInteractionApproval('call-1', false, {
            decisionId: display.decisionId,
        });
        await expect(wait).resolves.toBe(false);
    });

    it('user gets false when there is nothing waiting to approve', () => {
        const { projection } = createProjection();

        expect(projection.settleInteractionApproval('missing', true)).toBe(false);
        expect(projection.settleInteractionApproval('missing', false)).toBe(false);
    });

    it('user gets the task running again once the approval is settled', async () => {
        const state = withToolCall();
        const { display, wait } = requestApproval(state);
        expect(state.snapshot.status).toBe('waiting_approval');

        state.projection.settleInteractionApproval('call-1', true, {
            decisionId: display.decisionId,
        });
        await expect(wait).resolves.toBe(true);

        expect(state.snapshot.status).toBe('running');
        expect(state.snapshot.pendingToolApproval).toBeNull();
    });

    it('user cannot settle an approval twice with the same identity', async () => {
        const state = withToolCall();
        const { display, wait } = requestApproval(state);

        expect(
            state.projection.settleInteractionApproval('call-1', true, {
                decisionId: display.decisionId,
            })
        ).toBe(true);
        await expect(wait).resolves.toBe(true);

        expect(
            state.projection.settleInteractionApproval('call-1', false, {
                decisionId: display.decisionId,
            })
        ).toBe(false);
    });

    it('user still gets an approval registered when no assistant message is visible', () => {
        const { interactions, projection } = createProjection();
        const payload = approvalRequest('call-1');
        const display = projection.formatApproval(payload);
        const wait = interactions.registerApproval(display, payload.attemptToken);

        projection.renderApproval(display, payload);

        expect(projection.getPendingToolApproval()).toMatchObject({ callId: 'call-1' });
        projection.settleInteractionApproval('call-1', false, {
            decisionId: display.decisionId,
        });
        return expect(wait).resolves.toBe(false);
    });

    it('user gets every pending approval cleared when the task is cancelled', async () => {
        const state = withToolCall();
        const { wait } = requestApproval(state);

        state.projection.clearPendingApprovals();

        await expect(wait).resolves.toBe(false);
        expect(state.snapshot.pendingToolApproval).toBeNull();
    });

    it('user does not get a late approval from a superseded attempt rendered', async () => {
        const state = withToolCall();
        state.interactions.beginAttempt('attempt-2');
        const payload = approvalRequest('call-1');
        const display = state.projection.formatApproval(payload);
        const wait = state.interactions.registerApproval(display, 'attempt-1');

        await expect(wait).resolves.toBe(false);
        expect(state.interactions.pendingApproval).toBeNull();
    });
});

describe('user is asked a question by the model', () => {
    it('user gets the task paused while the question is pending', async () => {
        const state = withToolCall();
        const { record, wait } = requestQuestion(state);

        expect(state.snapshot.status).toBe('waiting_approval');
        expect(state.snapshot.pendingUserQuestion).toMatchObject({ callId: 'call-1' });

        expect(
            state.projection.settleInteractionQuestion(
                'call-1',
                [{ questionIndex: 0, selectedLabels: ['a.txt'], skipped: false }],
                record.decisionId
            )
        ).toBe(true);
        await expect(wait).resolves.toEqual([
            { questionIndex: 0, selectedLabels: ['a.txt'], skipped: false },
        ]);
    });

    it('user answers and the answers reach the caller', async () => {
        const state = withToolCall();
        const { record, wait } = requestQuestion(state);

        const answers = [{ questionIndex: 0, selectedLabels: ['a.txt'], skipped: false }];
        expect(
            state.projection.settleInteractionQuestion('call-1', answers, record.decisionId)
        ).toBe(true);

        await expect(wait).resolves.toEqual(answers);
    });

    it('user dismisses the question and the caller gets null', async () => {
        const state = withToolCall();
        const { record, wait } = requestQuestion(state);

        expect(state.projection.settleInteractionQuestion('call-1', null, record.decisionId)).toBe(
            true
        );

        await expect(wait).resolves.toBeNull();
    });

    it('user gets false when settling a question without its identity', () => {
        const state = withToolCall();
        const { wait } = requestQuestion(state);

        expect(state.projection.settleInteractionQuestion('call-1', null)).toBe(false);
        expect(state.snapshot.pendingUserQuestion?.callId).toBe('call-1');

        state.projection.settleInteractionQuestion(
            'call-1',
            null,
            state.snapshot.pendingUserQuestion?.decisionId
        );
        void wait;
    });

    it('user gets the pending question readable while it waits', async () => {
        const state = withToolCall();
        const { record, wait } = requestQuestion(state);

        expect(state.projection.getPendingUserQuestion()).toMatchObject({ callId: 'call-1' });

        state.projection.settleInteractionQuestion('call-1', null, record.decisionId);
        await expect(wait).resolves.toBeNull();
    });
});
