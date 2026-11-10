import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type {
    SessionTaskSnapshot,
    SessionTaskViewSnapshot,
} from '@/services/AgentService/task/types';
import { cloneTaskViewSnapshot } from '@/services/AgentService/task/viewSnapshot';

function createProjection() {
    const snapshot: SessionTaskSnapshot = {
        taskId: 'widget-task',
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
    let published: SessionTaskViewSnapshot;
    const projection = new SessionTaskProjection(snapshot, () => {
        published = cloneTaskViewSnapshot(snapshot, published);
    });
    projection.bootstrap([], 'Hello', []);
    const stream = (html: string) =>
        projection.handleChunk({
            content: '',
            done: false,
            toolCallDeltas: [
                {
                    index: 0,
                    callId: 'call-1',
                    name: 'builtin__show_widget',
                    isComplete: false,
                    argumentsBuffer:
                        '{"widgetId":"widget-1","html":' + JSON.stringify(html).slice(0, -1),
                },
            ],
        });
    return {
        projection,
        stream,
        view: () => published,
        html: () =>
            published.sessionHistory[published.sessionHistory.length - 1]?.widgets?.[0]?.html,
    };
}

const firstHtml = '<div>' + 'x'.repeat(2100);

describe('given a widget streams a large HTML draft', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
    });
    afterEach(() => vi.useRealTimers());

    it('user keeps the published draft when the same arguments arrive again', () => {
        const { stream, html } = createProjection();
        stream(firstHtml);
        stream(firstHtml);
        expect(html()).toBe(firstHtml);
    });

    it('user keeps the existing draft while the next update is delayed', () => {
        const { stream, html } = createProjection();
        stream(firstHtml);
        stream(firstHtml + 'next');
        expect(html()).toBe(firstHtml);
    });

    it('user receives the latest draft after the delay without another model chunk', () => {
        const { stream, html } = createProjection();
        stream(firstHtml);
        stream(firstHtml + 'next');
        stream(firstHtml + 'latest');
        vi.advanceTimersByTime(80);
        expect(html()).toBe(firstHtml + 'latest');
    });

    it('user keeps the newest draft when an older timer was delayed by a busy event loop', () => {
        const { stream, html } = createProjection();
        stream(firstHtml);
        stream(firstHtml + 'old');
        vi.setSystemTime(1100);
        stream(firstHtml + 'latest');
        vi.advanceTimersByTime(80);
        expect(html()).toBe(firstHtml + 'latest');
    });

    it('user keeps the finished widget when a pending draft update becomes due', () => {
        const { projection, stream, html } = createProjection();
        stream(firstHtml);
        stream(firstHtml + 'pending');
        projection.handleChunk({
            content: '',
            done: true,
            toolCalls: [
                {
                    id: 'call-1',
                    name: 'builtin__show_widget',
                    arguments: JSON.stringify({ widgetId: 'widget-1', html: '<p>finished</p>' }),
                },
            ],
        });
        vi.advanceTimersByTime(80);
        expect(html()).toBe('<p>finished</p>');
    });

    it.each(['completed', 'cancelled', 'failed'] as const)(
        'user receives no delayed draft after the task is %s',
        (status) => {
            const { projection, stream, view } = createProjection();
            stream(firstHtml);
            stream(firstHtml + 'pending');
            if (status === 'completed') projection.markCompleted();
            else if (status === 'cancelled') projection.markCancelled();
            else projection.markFailed('offline');
            const terminal = view();
            vi.advanceTimersByTime(80);
            expect(view()).toBe(terminal);
            expect(view().status).toBe(status);
        }
    );
});
