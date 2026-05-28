import { describe, expect, it } from 'vitest';

import type { SessionMessage } from '@/types/session';
import {
    buildLatestCompletedMessageMarker,
    isSessionHistorySettled,
    shouldAutoShrinkSearchSession,
} from '@/views/SearchView/autoShrinkPolicy';

function createAssistantMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
    return {
        id: 'assistant-1',
        role: 'assistant',
        content: 'done',
        parts: [
            {
                id: 'text-1',
                type: 'text',
                content: 'done',
            },
        ],
        timestamp: 1,
        ...overrides,
    };
}

describe('autoShrinkPolicy', () => {
    it('returns null when there is no active session or settled assistant output to read', () => {
        expect(buildLatestCompletedMessageMarker(null, [])).toBeNull();
        expect(
            buildLatestCompletedMessageMarker(7, [
                {
                    id: 'user-1',
                    role: 'user',
                    content: 'hello',
                    parts: [
                        {
                            id: 'text-user-1',
                            type: 'text',
                            content: 'hello',
                        },
                    ],
                    timestamp: 1,
                },
            ])
        ).toBeNull();
    });

    it('changes the marker when the latest assistant output changes terminal presentation on the same message id', () => {
        const baseMessage = createAssistantMessage();
        const completedMarker = buildLatestCompletedMessageMarker(7, [baseMessage]);
        const failedMarker = buildLatestCompletedMessageMarker(7, [
            createAssistantMessage({
                statusText: 'Request failed',
                isError: true,
            }),
        ]);

        expect(completedMarker).not.toBeNull();
        expect(failedMarker).not.toBeNull();
        expect(completedMarker).not.toBe(failedMarker);
    });

    it('treats streaming assistant output as unsettled and withholds the marker', () => {
        const streamingMessage = createAssistantMessage({
            isStreaming: true,
        });

        expect(isSessionHistorySettled([streamingMessage])).toBe(false);
        expect(buildLatestCompletedMessageMarker(7, [streamingMessage])).toBeNull();
    });

    it('treats pending approvals or executing tools as unsettled', () => {
        const approvalPendingMessage = createAssistantMessage({
            approvals: [
                {
                    id: 'approval-1',
                    callId: 'call-1',
                    status: 'pending',
                    title: 'Approve command',
                    description: 'Approve command',
                    command: 'dir',
                    riskLabel: 'low',
                    reason: 'Need approval',
                    commandLabel: 'Command',
                    approveLabel: 'Approve',
                    rejectLabel: 'Reject',
                    enterHint: 'Enter',
                    escHint: 'Esc',
                    keyboardApproveAt: 1,
                },
            ],
        });
        const executingToolMessage = createAssistantMessage({
            toolCalls: [
                {
                    id: 'call-1',
                    name: 'bash',
                    namespacedName: 'builtin__bash',
                    source: 'builtin',
                    arguments: {},
                    status: 'executing',
                },
            ],
        });

        expect(isSessionHistorySettled([approvalPendingMessage])).toBe(false);
        expect(buildLatestCompletedMessageMarker(7, [approvalPendingMessage])).toBeNull();
        expect(isSessionHistorySettled([executingToolMessage])).toBe(false);
        expect(buildLatestCompletedMessageMarker(7, [executingToolMessage])).toBeNull();
    });

    it('requires every assistant message in the visible history to be settled', () => {
        const settledMessage = createAssistantMessage({
            id: 'assistant-1',
            timestamp: 1,
        });
        const unsettledMessage = createAssistantMessage({
            id: 'assistant-2',
            timestamp: 2,
            toolCalls: [
                {
                    id: 'call-2',
                    name: 'bash',
                    namespacedName: 'builtin__bash',
                    source: 'builtin',
                    arguments: {},
                    status: 'awaiting_approval',
                },
            ],
        });

        expect(isSessionHistorySettled([settledMessage, unsettledMessage])).toBe(false);
        expect(buildLatestCompletedMessageMarker(7, [settledMessage, unsettledMessage])).toBeNull();
    });

    it('only allows timed auto-shrink after inactivity when the session is idle and the latest completed message marker was already seen', () => {
        const marker = buildLatestCompletedMessageMarker(7, [createAssistantMessage()]);

        expect(
            shouldAutoShrinkSearchSession({
                timedOut: true,
                sessionIdle: true,
                latestCompletedMessageMarker: marker,
                latestSeenCompletedMessageMarker: marker,
            })
        ).toBe(true);
        expect(
            shouldAutoShrinkSearchSession({
                timedOut: true,
                sessionIdle: true,
                latestCompletedMessageMarker: marker,
                latestSeenCompletedMessageMarker: null,
            })
        ).toBe(false);
        expect(
            shouldAutoShrinkSearchSession({
                timedOut: true,
                sessionIdle: false,
                latestCompletedMessageMarker: marker,
                latestSeenCompletedMessageMarker: marker,
            })
        ).toBe(false);
        expect(
            shouldAutoShrinkSearchSession({
                timedOut: false,
                sessionIdle: true,
                latestCompletedMessageMarker: marker,
                latestSeenCompletedMessageMarker: marker,
            })
        ).toBe(false);
    });
});
