import { describe, expect, it } from 'vitest';

import { buildMatchTokens, splitNameByTokens } from '@/utils/searchHighlight';

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

    it.each([
        {
            name: 'skill-creator',
            query: 'skillc',
            expected: [
                { text: 'skill', matched: true },
                { text: '-', matched: false },
                { text: 'c', matched: true },
                { text: 'reator', matched: false },
            ],
        },
        {
            name: 'Skill Creator',
            query: 'SKILLC',
            expected: [
                { text: 'Skill', matched: true },
                { text: ' ', matched: false },
                { text: 'C', matched: true },
                { text: 'reator', matched: false },
            ],
        },
        {
            name: '技能创建助手',
            query: '技创助',
            expected: [
                { text: '技', matched: true },
                { text: '能', matched: false },
                { text: '创', matched: true },
                { text: '建', matched: false },
                { text: '助', matched: true },
                { text: '手', matched: false },
            ],
        },
    ])(
        'user given the skill name $name when searching $query then sees each ordered matching character highlighted',
        ({ name, query, expected }) => {
            expect(splitNameByTokens(name, buildMatchTokens(query), true)).toEqual(expected);
        }
    );

    it('user given a name with a continuous match when using fuzzy search then sees the continuous occurrence highlighted', () => {
        expect(splitNameByTokens('s-abc-skill', ['skill'], true)).toEqual([
            { text: 's-abc-', matched: false },
            { text: 'skill', matched: true },
        ]);
    });

    it('user given an unrelated or incomplete ordered query when reading the name then sees no partial match highlight', () => {
        for (const query of ['skillcx', 'crskill', '']) {
            expect(splitNameByTokens('skill-creator', buildMatchTokens(query), true)).toEqual([
                { text: 'skill-creator', matched: false },
            ]);
        }
        expect(splitNameByTokens('skill-creator', ['skillc'])).toEqual([
            { text: 'skill-creator', matched: false },
        ]);
    });
});
