import { describe, expect, it } from 'vitest';

import type { SessionMessage } from '@/types/session';
import {
    estimateMessageHeight,
    estimateMessageListItemSize,
} from '@/views/SearchView/components/ConversationPanel/messageHeightEstimate';

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

function shortMessage(index: number): SessionMessage {
    return message({
        id: `m${index}`,
        content: '好的，收到。',
        role: index % 2 === 0 ? 'user' : 'assistant',
    });
}

function hugeMessage(index: number): SessionMessage {
    return message({
        id: `h${index}`,
        content: '长回答内容。'.repeat(900),
        parts: Array.from({ length: 12 }, (_, partIndex) => ({
            id: `p${partIndex}`,
            type: 'text',
            content: '工具输出片段。'.repeat(60),
        })) as never,
    });
}

describe('when the virtual list sizes messages', () => {
    it('user gets a small estimate for short turns', () => {
        expect(estimateMessageHeight(message({ content: '好的' }))).toBeLessThan(320);
    });

    it('user gets a large estimate for a long answer with many parts', () => {
        const estimated = estimateMessageHeight(hugeMessage(0));

        // 固定按 320px 估算时这条会被严重低估，virtua 随后要补偿几千像素。
        expect(estimated).toBeGreaterThan(5000);
    });

    it('user gets the median so one giant answer does not inflate every row', () => {
        const messages = [
            ...Array.from({ length: 7 }, (_, index) => shortMessage(index)),
            hugeMessage(0),
        ];

        const size = estimateMessageListItemSize(messages);

        expect(size).toBeLessThan(400);
    });

    it('user gets a usable size when the list is empty', () => {
        expect(estimateMessageListItemSize([])).toBeGreaterThan(0);
    });
});
