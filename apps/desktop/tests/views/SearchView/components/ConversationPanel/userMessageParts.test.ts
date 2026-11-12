import { describe, expect, it } from 'vitest';

import { createInputHistorySnapshot } from '@/types/session';
import { buildUserMessageInlineParts } from '@/views/SearchView/components/ConversationPanel/components/userMessageParts';

const skill = {
    name: 'code-quality-review',
    path: 'C:/Users/demo/.agents/skills/code-quality-review/SKILL.md',
};

describe('buildUserMessageInlineParts', () => {
    it('user renders skill tags inline from the structured editor snapshot', () => {
        expect(
            buildUserMessageInlineParts(
                'fallback',
                createInputHistorySnapshot({
                    text: 'Review with  now',
                    attachments: [],
                    editorDoc: {
                        type: 'doc',
                        content: [
                            {
                                type: 'paragraph',
                                content: [
                                    { type: 'text', text: 'Review with ' },
                                    {
                                        type: 'skillTag',
                                        attrs: skill,
                                    },
                                    { type: 'text', text: ' now' },
                                ],
                            },
                        ],
                    },
                })
            )
        ).toEqual([
            {
                type: 'text',
                text: 'Review with ',
            },
            {
                type: 'skill',
                ...skill,
            },
            {
                type: 'text',
                text: ' now',
            },
        ]);
    });

    it('user falls back to appending selected skills when older snapshots have no editor document', () => {
        expect(
            buildUserMessageInlineParts(
                'fallback',
                createInputHistorySnapshot({
                    text: 'Review this',
                    attachments: [],
                    skills: [skill],
                })
            )
        ).toEqual([
            {
                type: 'text',
                text: 'Review this',
            },
            {
                type: 'skill',
                ...skill,
            },
        ]);
    });

    it('user preserves hard breaks and paragraph breaks from structured editor snapshots', () => {
        expect(
            buildUserMessageInlineParts(
                'fallback',
                createInputHistorySnapshot({
                    text: 'First\nline\nSecond paragraph',
                    attachments: [],
                    editorDoc: {
                        type: 'doc',
                        content: [
                            {
                                type: 'paragraph',
                                content: [
                                    { type: 'text', text: 'First' },
                                    { type: 'hardBreak' },
                                    { type: 'text', text: 'line' },
                                ],
                            },
                            {
                                type: 'paragraph',
                                content: [{ type: 'text', text: 'Second paragraph' }],
                            },
                        ],
                    },
                })
            )
        ).toEqual([
            {
                type: 'text',
                text: 'First\nline\nSecond paragraph',
            },
        ]);
    });

    it('user supports historical kebab-case skill nodes and skips incomplete skill attrs', () => {
        expect(
            buildUserMessageInlineParts(
                'fallback',
                createInputHistorySnapshot({
                    text: ' and ignore after',
                    attachments: [],
                    editorDoc: {
                        type: 'doc',
                        content: [
                            {
                                type: 'paragraph',
                                content: [
                                    {
                                        type: 'skill-tag',
                                        attrs: skill,
                                    },
                                    { type: 'text', text: ' and ignore ' },
                                    {
                                        type: 'skillTag',
                                        attrs: {
                                            name: 'missing-path',
                                        },
                                    },
                                    { type: 'text', text: 'after' },
                                ],
                            },
                        ],
                    },
                })
            )
        ).toEqual([
            {
                type: 'skill',
                ...skill,
            },
            {
                type: 'text',
                text: ' and ignore after',
            },
        ]);
    });

    it('user falls back to snapshot text or message text when structured content is empty', () => {
        expect(
            buildUserMessageInlineParts(
                'message text',
                createInputHistorySnapshot({
                    text: 'snapshot text',
                    attachments: [],
                    editorDoc: {
                        type: 'doc',
                        content: [{ type: 'paragraph', content: [] }],
                    },
                })
            )
        ).toEqual([
            {
                type: 'text',
                text: 'snapshot text',
            },
        ]);

        expect(buildUserMessageInlineParts('message text')).toEqual([
            {
                type: 'text',
                text: 'message text',
            },
        ]);
        expect(buildUserMessageInlineParts('')).toEqual([]);
    });

    it('user can render skill-only historical snapshots without adding empty text parts', () => {
        expect(
            buildUserMessageInlineParts(
                '',
                createInputHistorySnapshot({
                    text: '',
                    attachments: [],
                    skills: [skill],
                })
            )
        ).toEqual([
            {
                type: 'skill',
                ...skill,
            },
        ]);
    });

    it('user sees the saved message text when an older editor document contains stale text', () => {
        expect(
            buildUserMessageInlineParts(
                'Saved message',
                createInputHistorySnapshot({
                    text: 'Saved message',
                    skills: [skill],
                    editorDoc: {
                        type: 'doc',
                        content: [
                            {
                                type: 'paragraph',
                                content: [
                                    { type: 'text', text: 'Old draft' },
                                    { type: 'skillTag', attrs: skill },
                                ],
                            },
                        ],
                    },
                })
            )
        ).toEqual([
            { type: 'text', text: 'Saved message' },
            { type: 'skill', ...skill },
        ]);
    });
});
