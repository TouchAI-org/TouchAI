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

describe('when the search window considers shrinking itself', () => {
    it('user gets no shrink while there is nothing settled to measure', () => {
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

    it('user gets a new shrink marker when the same reply changes its final presentation', () => {
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

    it('user gets no shrink while the reply is still streaming', () => {
        const streamingMessage = createAssistantMessage({
            isStreaming: true,
        });

        expect(isSessionHistorySettled([streamingMessage])).toBe(false);
        expect(buildLatestCompletedMessageMarker(7, [streamingMessage])).toBeNull();
    });

    it('user gets no shrink while a tool or approval is still pending', () => {
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
            parts: [
                {
                    id: 'part-tool-1',
                    type: 'tool_call',
                    toolCall: {
                        id: 'call-1',
                        name: 'bash',
                        namespacedName: 'builtin__bash',
                        source: 'builtin',
                        arguments: {},
                        status: 'executing',
                    },
                },
            ],
        });

        expect(isSessionHistorySettled([approvalPendingMessage])).toBe(false);
        expect(buildLatestCompletedMessageMarker(7, [approvalPendingMessage])).toBeNull();
        expect(isSessionHistorySettled([executingToolMessage])).toBe(false);
        expect(buildLatestCompletedMessageMarker(7, [executingToolMessage])).toBeNull();
    });

    it('user gets no shrink until every visible reply has settled', () => {
        const settledMessage = createAssistantMessage({
            id: 'assistant-1',
            timestamp: 1,
        });
        const unsettledMessage = createAssistantMessage({
            id: 'assistant-2',
            timestamp: 2,
            parts: [
                {
                    id: 'part-tool-2',
                    type: 'tool_call',
                    toolCall: {
                        id: 'call-2',
                        name: 'bash',
                        namespacedName: 'builtin__bash',
                        source: 'builtin',
                        arguments: {},
                        status: 'awaiting_approval',
                    },
                },
            ],
        });

        expect(isSessionHistorySettled([settledMessage, unsettledMessage])).toBe(false);
        expect(buildLatestCompletedMessageMarker(7, [settledMessage, unsettledMessage])).toBeNull();
    });

    it('user gets the timed shrink only when idle and the last reply was already shown', () => {
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
