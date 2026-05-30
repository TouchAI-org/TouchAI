import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { buildSessionStatusReminder } from '@/services/AgentService/task/center';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';

function createSnapshot(overrides: Partial<SessionTaskSnapshot> = {}): SessionTaskSnapshot {
    return {
        taskId: 'task-1',
        sessionId: 1,
        turnId: null,
        status: 'running',
        executionMode: 'background',
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
        ...overrides,
    };
}

describe('SessionTaskCenter status reminders', () => {
    beforeEach(() => {
        setLocale('en-US');
    });

    it('creates an open reminder when a background task waits for a user question', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'waiting_approval',
                pendingUserQuestion: {
                    callId: 'question-call',
                    sourceMessageId: 'assistant-1',
                    createdAt: 1,
                    questions: [
                        {
                            question: 'Pick the deployment target',
                            header: 'Deploy',
                            options: [{ label: 'Staging' }, { label: 'Production' }],
                        },
                    ],
                },
            })
        );

        expect(reminder).toEqual({
            kind: 'waiting_approval',
            title: 'Waiting for response',
            body: 'Pick the deployment target',
            approval: null,
        });
    });
});
