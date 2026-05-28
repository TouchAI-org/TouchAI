import { describe, expect, it } from 'vitest';

import type { SessionMessage } from '@/types/session';
import {
    buildLatestCompletedMessageMarker,
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
