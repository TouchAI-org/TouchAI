import { describe, expect, it } from 'vitest';

import { groupToolRuns } from '@/views/SearchView/components/ConversationPanel/toolRunGroups';

interface Part {
    id: string;
    type: 'text' | 'tool_call';
}

const parts: Part[] = [
    { id: 'a', type: 'tool_call' },
    { id: 'b', type: 'tool_call' },
    { id: 'c', type: 'tool_call' },
    { id: 'd', type: 'text' },
    { id: 'e', type: 'tool_call' },
];

const options = {
    isToolCall: (part: Part) => part.type === 'tool_call',
    getId: (part: Part) => part.id,
    minRun: 3,
};

describe('groupToolRuns', () => {
    it('collapses a long consecutive run into one block', () => {
        const blocks = groupToolRuns(parts, options);

        expect(blocks.map((block) => block.kind)).toEqual(['tool-run', 'part', 'part']);
        const first = blocks[0]!;
        expect(first.kind).toBe('tool-run');
        if (first.kind === 'tool-run') {
            expect(first.parts.map((part) => part.id)).toEqual(['a', 'b', 'c']);
            expect(first.id).toBe('tool-run:a');
        }
    });

    it('keeps short runs as individual parts', () => {
        const blocks = groupToolRuns(parts, { ...options, minRun: 4 });

        expect(blocks.every((block) => block.kind === 'part')).toBe(true);
        expect(blocks).toHaveLength(5);
    });

    it('handles a run at the end of the list', () => {
        const blocks = groupToolRuns(
            [
                { id: 'a', type: 'text' },
                { id: 'b', type: 'tool_call' },
                { id: 'c', type: 'tool_call' },
                { id: 'd', type: 'tool_call' },
            ],
            options
        );

        expect(blocks.map((block) => block.kind)).toEqual(['part', 'tool-run']);
    });

    it('never groups a single tool call', () => {
        const blocks = groupToolRuns([{ id: 'only', type: 'tool_call' }], {
            ...options,
            minRun: 1,
        });

        expect(blocks).toEqual([{ kind: 'part', part: { id: 'only', type: 'tool_call' } }]);
    });

    it('collates every tool call of a message in all mode', () => {
        // 真实数据里是 reasoning/tool_call/text 交替，连续合并合不掉。
        const alternating: Part[] = [
            { id: 'r1', type: 'text' },
            { id: 't1', type: 'tool_call' },
            { id: 'r2', type: 'text' },
            { id: 't2', type: 'tool_call' },
            { id: 'r3', type: 'text' },
            { id: 't3', type: 'tool_call' },
        ];

        const blocks = groupToolRuns(alternating, { ...options, mode: 'all' });

        expect(blocks.map((block) => block.kind)).toEqual(['part', 'tool-run', 'part', 'part']);
        const group = blocks[1]!;
        expect(group.kind).toBe('tool-run');
        if (group.kind === 'tool-run') {
            expect(group.parts.map((part) => part.id)).toEqual(['t1', 't2', 't3']);
        }
    });

    it('keeps every part when all mode finds too few tool calls', () => {
        const blocks = groupToolRuns(
            [
                { id: 'a', type: 'text' },
                { id: 'b', type: 'tool_call' },
                { id: 'c', type: 'text' },
            ],
            { ...options, mode: 'all' }
        );

        expect(blocks.every((block) => block.kind === 'part')).toBe(true);
        expect(blocks).toHaveLength(3);
    });
});
