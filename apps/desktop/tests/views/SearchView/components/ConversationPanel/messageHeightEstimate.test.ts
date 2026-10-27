import { describe, expect, it } from 'vitest';

import type { SessionMessage } from '@/types/session';
import { estimateMessageHeight } from '@/views/SearchView/components/ConversationPanel/messageHeightEstimate';

function message(overrides: Partial<SessionMessage> = {}): SessionMessage {
    return {
        id: 'm1',
        role: 'assistant',
        content: '',
        parts: [],
        timestamp: 1,
        ...overrides,
    };
}

describe('estimateMessageHeight', () => {
    it('keeps short messages at the base height', () => {
        expect(estimateMessageHeight(message({ content: '好的' }))).toBe(80);
    });

    it('grows with the amount of text', () => {
        const short = estimateMessageHeight(message({ content: 'a'.repeat(200) }));
        const long = estimateMessageHeight(message({ content: 'a'.repeat(2000) }));

        expect(long).toBeGreaterThan(short);
    });

    it('counts text parts as well as the plain content', () => {
        const withoutParts = estimateMessageHeight(message({ content: 'a'.repeat(600) }));
        const withParts = estimateMessageHeight(
            message({
                content: 'a'.repeat(600),
                parts: [{ id: 'p1', type: 'text', content: 'a'.repeat(600) } as never],
            })
        );

        expect(withParts).toBeGreaterThan(withoutParts);
    });

    it('counts wide characters as two columns', () => {
        const latin = estimateMessageHeight(message({ content: 'a'.repeat(560) }));
        const wide = estimateMessageHeight(message({ content: '中'.repeat(280) }));

        expect(wide).toBe(latin);
    });

    it('reserves a stable height for widget messages', () => {
        expect(
            estimateMessageHeight(
                message({ parts: [{ id: 'p1', type: 'widget', widgetId: 'w' } as never] })
            )
        ).toBe(360);
    });
});
