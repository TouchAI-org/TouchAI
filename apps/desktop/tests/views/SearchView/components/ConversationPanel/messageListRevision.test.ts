import { describe, expect, it } from 'vitest';

import type { SessionMessage } from '@/types/session';
import { buildMessageListRevision } from '@/views/SearchView/components/ConversationPanel/messageListRevision';

function message(overrides: Partial<SessionMessage> = {}): SessionMessage {
    return {
        id: 'm1',
        role: 'assistant',
        content: 'hello',
        parts: [{ id: 'p1', type: 'text', content: 'hello' }],
        timestamp: 1,
        ...overrides,
    };
}

describe('buildMessageListRevision', () => {
    it('changes when a message is appended', () => {
        const before = buildMessageListRevision([message()]);
        const after = buildMessageListRevision([message(), message({ id: 'm2' })]);

        expect(after).not.toBe(before);
    });

    it('changes when the tail message content grows', () => {
        const before = buildMessageListRevision([message({ content: 'a' })]);
        const after = buildMessageListRevision([message({ content: 'ab' })]);

        expect(after).not.toBe(before);
    });

    it('changes when the tail message gains parts or streaming state', () => {
        const base = buildMessageListRevision([message()]);
        expect(
            buildMessageListRevision([
                message({ parts: [...message().parts, { id: 'p2', type: 'text', content: 'x' }] }),
            ])
        ).not.toBe(base);
        expect(buildMessageListRevision([message({ isStreaming: true })])).not.toBe(base);
    });

    it('ignores nested changes in earlier messages so auto-scroll does not rescan history', () => {
        const history = [message({ content: 'first' }), message({ id: 'm2', content: 'tail' })];
        const before = buildMessageListRevision(history);
        const mutated = [
            message({ content: 'first changed deeply' }),
            message({ id: 'm2', content: 'tail' }),
        ];

        expect(buildMessageListRevision(mutated)).toBe(before);
    });
});
