import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';

import { getEditorText } from '@/views/SearchView/components/SearchBar/utils/tiptap';

const schema = new Schema({
    nodes: {
        doc: {
            content: 'block+',
        },
        paragraph: {
            content: 'inline*',
            group: 'block',
            parseDOM: [{ tag: 'p' }],
            toDOM: () => ['p', 0],
        },
        text: {
            group: 'inline',
        },
        hardBreak: {
            group: 'inline',
            inline: true,
            selectable: false,
            parseDOM: [{ tag: 'br' }],
            toDOM: () => ['br'],
        },
        attachmentTag: {
            group: 'inline',
            inline: true,
            atom: true,
            selectable: true,
            attrs: {
                attachmentId: { default: null },
            },
            toDOM: () => ['span', { 'data-attachment-tag': '' }],
        },
    },
});

function createEditorFromDoc(doc: ReturnType<typeof schema.node>): Editor {
    return {
        state: {
            doc,
        },
    } as Editor;
}

describe('SearchBar tiptap utilities', () => {
    it('serializes hard breaks as newlines for pasted and manually wrapped text', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.text('trusted proxy:'),
                schema.nodes.hardBreak!.create(),
                schema.text('true.'),
            ]),
        ]);

        expect(getEditorText(createEditorFromDoc(doc))).toBe('trusted proxy:\ntrue.');
    });

    it('keeps non-text search tags out of the extracted plain text', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.text('before'),
                schema.nodes.attachmentTag!.create({ attachmentId: 'file-1' }),
                schema.text('after'),
            ]),
        ]);

        expect(getEditorText(createEditorFromDoc(doc))).toBe('beforeafter');
    });
});
