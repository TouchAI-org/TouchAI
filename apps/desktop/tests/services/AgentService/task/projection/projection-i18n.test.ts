import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';

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

function createProjection(snapshot = createSnapshot()): SessionTaskProjection {
    return new SessionTaskProjection(snapshot, vi.fn());
}

describe('SessionTaskProjection i18n statuses', () => {
    beforeEach(() => {
        setLocale('zh-CN');
        let uuidIndex = 0;
        vi.spyOn(crypto, 'randomUUID').mockImplementation(
            () => `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, '0')}`
        );
    });

    it('uses English failed request status when the active locale is English', () => {
        setLocale('en-US');
        const snapshot = createSnapshot();
        const projection = createProjection(snapshot);

        projection.bootstrap([], 'Hello', []);
        projection.markFailed('Provider exploded');

        const statusMessage = snapshot.sessionHistory[snapshot.sessionHistory.length - 1];
        expect(statusMessage).toMatchObject({
            role: 'assistant',
            content: 'Request failed: Provider exploded',
            isError: true,
        });
        expect(statusMessage?.parts).toMatchObject([
            { type: 'text', content: 'Request failed: Provider exploded' },
        ]);
    });

    it('localizes known app-generated AiError default text received through task failed events', () => {
        setLocale('en-US');
        const snapshot = createSnapshot();
        const projection = createProjection(snapshot);

        projection.bootstrap([], 'Hello', []);
        projection.syncTaskMetadata({
            type: 'task_failed',
            taskId: 'task-1',
            turnId: 1,
            error: '模型返回了空回复，请尝试重新提问或更换模型',
        });

        const statusMessage = snapshot.sessionHistory[snapshot.sessionHistory.length - 1];
        expect(statusMessage).toMatchObject({
            role: 'assistant',
            content:
                'Request failed: The model returned an empty response. Try asking again or switch models.',
            isError: true,
        });
        expect(snapshot.error).toBe(
            'The model returned an empty response. Try asking again or switch models.'
        );
    });

    it('uses English cancelled request status when the active locale is English', () => {
        setLocale('en-US');
        const snapshot = createSnapshot();
        const projection = createProjection(snapshot);

        projection.bootstrap([], 'Hello', []);
        projection.markCancelled();

        const statusMessage = snapshot.sessionHistory[snapshot.sessionHistory.length - 1];
        expect(statusMessage).toMatchObject({
            role: 'assistant',
            content: 'Request cancelled',
            isCancelled: true,
        });
        expect(statusMessage?.parts).toMatchObject([
            { type: 'text', content: 'Request cancelled' },
        ]);
    });

    it('uses English pending approval cancellation text when clearing approvals', async () => {
        setLocale('en-US');
        const snapshot = createSnapshot();
        const projection = createProjection(snapshot);

        projection.bootstrap([], 'Hello', []);
        const decision = projection.requestToolApproval({
            callId: 'call-1',
            command: 'Remove-Item file.txt',
        } as never);

        projection.clearPendingApprovals();

        await expect(decision).resolves.toBe(false);
        expect(snapshot.pendingApprovals).toEqual([]);
        expect(snapshot.sessionHistory[1]?.approvals?.[0]).toMatchObject({
            callId: 'call-1',
            status: 'cancelled',
            resolutionText: 'Request cancelled',
        });
    });
});
