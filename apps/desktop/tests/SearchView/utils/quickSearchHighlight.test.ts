import { describe, expect, it } from 'vitest';

import {
    buildMatchTokens,
    splitNameByTokens,
} from '@/views/SearchView/components/QuickSearchPanel/utils/quickSearchHighlight';

describe('when the quick search panel highlights what the user typed', () => {
    it('user sees duplicate and padded query words treated as one', () => {
        expect(buildMatchTokens('  Touch   AI  touch assistant  ')).toEqual([
            'assistant',
            'touch',
            'ai',
        ]);
    });

    it('user sees the whole name unhighlighted when the query is empty', () => {
        expect(splitNameByTokens('TouchAI Desktop', [])).toEqual([
            {
                text: 'TouchAI Desktop',
                matched: false,
            },
        ]);
    });

    it('user sees every matching part of the name highlighted regardless of case', () => {
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

    it('user sees repeated matches highlighted without empty gaps', () => {
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

    it('returns the same array instance for repeated identical input', () => {
        const first = splitNameByTokens('TouchAI Desktop', ['touch']);
        const second = splitNameByTokens('TouchAI Desktop', ['touch']);

        expect(second).toBe(first);
    });

    it('keeps results separate when tokens differ', () => {
        const touch = splitNameByTokens('TouchAI Desktop', ['touch']);
        const desktop = splitNameByTokens('TouchAI Desktop', ['desktop']);

        expect(touch).not.toBe(desktop);
        expect(touch.map((segment) => segment.matched)).toContain(true);
        expect(desktop.map((segment) => segment.matched)).toContain(true);
    });

    it('user sees a blank segment for an empty name', () => {
        expect(splitNameByTokens('', ['touch'])).toEqual([{ text: '', matched: false }]);
    });

    it('user still gets highlights after the segment cache evicts old entries', () => {
        for (let index = 0; index < 300; index += 1) {
            splitNameByTokens(`filler-${index}`, ['filler']);
        }

        const segments = splitNameByTokens('TouchAI Desktop', ['touch']);

        expect(segments.map((segment) => segment.text).join('')).toBe('TouchAI Desktop');
        expect(segments.some((segment) => segment.matched)).toBe(true);
    });

    it('user gets no highlight when the query never appears in the name', () => {
        expect(splitNameByTokens('TouchAI Desktop', ['zzz'])).toEqual([
            { text: 'TouchAI Desktop', matched: false },
        ]);
    });
});
