import { describe, expect, it } from 'vitest';

import { classifyMessageListChange } from '@/views/SearchView/components/ConversationPanel/messageListChange';

describe('message list change classification', () => {
    it('treats a longer list with an unchanged prefix as appended output', () => {
        expect(classifyMessageListChange(['a', 'b'], ['a', 'b', 'c'])).toBe('append');
    });

    it('treats a longer list with an unchanged suffix as prepended history', () => {
        // 向顶部加载更早一页：尾部不变，只有前面多了消息。
        expect(classifyMessageListChange(['c', 'd'], ['a', 'b', 'c', 'd'])).toBe('prepend');
    });

    it('treats a rewritten list as a replacement', () => {
        expect(classifyMessageListChange(['a', 'b'], ['x', 'b', 'c'])).toBe('replace');
        expect(classifyMessageListChange(['a', 'b'], ['a', 'b'])).toBe('none');
        expect(classifyMessageListChange(['a', 'b'], ['a'])).toBe('replace');
    });

    it('reports a cleared list', () => {
        expect(classifyMessageListChange(['a'], [])).toBe('clear');
        expect(classifyMessageListChange([], [])).toBe('none');
        expect(classifyMessageListChange([], ['a'])).toBe('replace');
    });
});
