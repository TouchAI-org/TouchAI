import { describe, expect, it } from 'vitest';

import {
    buildMatchTokens,
    splitNameByTokens,
} from '@/views/SearchView/components/QuickSearchPanel/utils/quickSearchHighlight';

describe('quickSearchHighlight', () => {
    it('normalizes query tokens by trimming, deduplicating, and sorting longer matches first', () => {
        expect(buildMatchTokens('  Touch   AI  touch assistant  ')).toEqual([
            'assistant',
            'touch',
            'ai',
        ]);
    });

    it('returns the original name as a single unmatched segment when there are no tokens', () => {
        expect(splitNameByTokens('TouchAI Desktop', [])).toEqual([
            {
                text: 'TouchAI Desktop',
                matched: false,
            },
        ]);
    });

    it('marks all token matches case-insensitively and merges overlapping ranges into stable segments', () => {
        expect(splitNameByTokens('TouchAI Assistant', ['touch', 'ai', 'assistant'])).toEqual([
            {
                text: 'TouchAI',
                matched: true,
            },
            {
                text: ' ',
                matched: false,
            },
            {
                text: 'Assistant',
                matched: true,
            },
        ]);
    });

    it('highlights repeated token occurrences without creating duplicate empty segments', () => {
        expect(splitNameByTokens('todo-tool-todo', ['todo'])).toEqual([
            {
                text: 'todo',
                matched: true,
            },
            {
                text: '-tool-',
                matched: false,
            },
            {
                text: 'todo',
                matched: true,
            },
        ]);
    });
});
