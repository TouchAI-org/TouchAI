import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { TaskInteractions } from '@/services/AgentService/task/interactions';
import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';
import { selectToolCalls } from '@/utils/session';

function createSnapshot(): SessionTaskSnapshot {
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

function createProjection(snapshot = createSnapshot()): SessionTaskProjection {
    return new SessionTaskProjection(snapshot, vi.fn());
}

describe('user reads live task statuses in their own language', () => {
    beforeEach(() => {
        setLocale('zh-CN');
        let uuidIndex = 0;
        vi.spyOn(crypto, 'randomUUID').mockImplementation(
            () => `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, '0')}`
        );
    });

    it('user reads the failed request status in English', () => {
        setLocale('en-US');
        const snapshot = createSnapshot();
        const projection = createProjection(snapshot);

        projection.bootstrap([], 'Hello', []);
        projection.markFailed('The provider request failed.');

        const statusMessage = snapshot.sessionHistory[snapshot.sessionHistory.length - 1];
        expect(statusMessage).toMatchObject({
            role: 'assistant',
            content: 'Request failed: The provider request failed.',
            isError: true,
        });
        expect(statusMessage?.parts).toMatchObject([
            { type: 'text', content: 'Request failed: The provider request failed.' },
        ]);
        expect(statusMessage?.content).not.toContain('secret diagnostic');
        expect(snapshot.error).toBe('The provider request failed.');
    });

    it('user keeps the runtime-provided failure copy in the active language', () => {
        setLocale('en-US');
        const snapshot = createSnapshot();
        const projection = createProjection(snapshot);

        projection.bootstrap([], 'Hello', []);
        projection.syncTaskMetadata({
            type: 'task_failed',
            taskId: 'task-1',
            turnId: 1,
            error: 'The model returned an empty response. Try asking again or switch models.',
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

    it('user keeps an already-normalized unsupported-input message unchanged', () => {
        setLocale('en-US');
        const snapshot = createSnapshot();
        const projection = createProjection(snapshot);

        projection.bootstrap([], 'Hello', []);
        projection.syncTaskMetadata({
            type: 'task_failed',
            taskId: 'task-1',
            turnId: 1,
            error: 'The selected model does not support image/file input. Choose another model.',
        });

        const statusMessage = snapshot.sessionHistory[snapshot.sessionHistory.length - 1];
        expect(statusMessage).toMatchObject({
            role: 'assistant',
            content:
                'Request failed: The selected model does not support image/file input. Choose another model.',
            isError: true,
        });
        expect(snapshot.error).toBe(
            'The selected model does not support image/file input. Choose another model.'
        );
    });

    it('user reads the cancelled request status in English', () => {
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

    it('user reads the pending approval cancellation text in English', async () => {
        setLocale('en-US');
        const snapshot = createSnapshot();
        const interactions = new TaskInteractions('task-1');
        interactions.beginAttempt('attempt-1');
        const projection = new SessionTaskProjection(snapshot, vi.fn(), interactions);

        projection.bootstrap([], 'Hello', []);
        const payload = {
            callId: 'call-1',
            command: 'Remove-Item file.txt',
        } as never;
        const display = projection.formatApproval(payload);
        const decision = interactions.registerApproval(display, 'attempt-1');
        projection.renderApproval(display, payload);

        projection.clearPendingApprovals();

        await expect(decision).resolves.toBe(false);
        expect(snapshot.pendingApprovals).toEqual([]);
        expect(snapshot.sessionHistory[1]?.approvals?.[0]).toMatchObject({
            callId: 'call-1',
            status: 'cancelled',
            resolutionText: 'Request cancelled',
        });
    });

    it('user sees built-in tool presentation updated from a structured call end', () => {
        setLocale('zh-CN');
        const snapshot = createSnapshot();
        const projection = createProjection(snapshot);

        projection.bootstrap([], '查一下 OpenClaw', []);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_start',
                callId: 'call-1',
                toolName: 'WebSearch',
                namespacedName: 'builtin__web_search',
                source: 'builtin',
                arguments: {
                    query: 'OpenClaw latest updates',
                    description: '搜索 OpenClaw 项目信息',
                },
                builtinConversationSemantic: {
                    action: 'search',
                    target: 'OpenClaw 项目信息',
                },
            },
        });
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_end',
                callId: 'call-1',
                result: 'Web search\nQuery: OpenClaw latest updates',
                isError: false,
                durationMs: 10,
                finalStatus: 'completed',
                builtinConversationSemantic: {
                    action: 'search',
                    target: 'OpenClaw 项目信息 · GitHub',
                },
            },
        });

        const projectedMessage = snapshot.sessionHistory[1];
        expect(projectedMessage ? selectToolCalls(projectedMessage)[0] : undefined).toMatchObject({
            status: 'completed',
            builtinConversationSemantic: {
                action: 'search',
                target: 'OpenClaw 项目信息 · GitHub',
            },
            builtinPresentation: {
                content: 'OpenClaw 项目信息 · GitHub',
            },
        });
    });
});
