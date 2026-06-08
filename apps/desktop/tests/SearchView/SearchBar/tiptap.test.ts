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

    it('serializes consecutive hard breaks as consecutive newlines', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.text('line1'),
                schema.nodes.hardBreak!.create(),
                schema.nodes.hardBreak!.create(),
                schema.text('line2'),
            ]),
        ]);

        expect(getEditorText(createEditorFromDoc(doc))).toBe('line1\n\nline2');
    });

    it('serializes hard-break-only paragraphs as newline content', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.nodes.hardBreak!.create(),
                schema.nodes.hardBreak!.create(),
            ]),
        ]);

        expect(getEditorText(createEditorFromDoc(doc))).toBe('\n\n');
    });

    it('preserves paragraph boundaries and hard breaks together', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.text('para1'),
                schema.nodes.hardBreak!.create(),
                schema.text('wrap1'),
            ]),
            schema.nodes.paragraph!.create(null, [
                schema.text('para2'),
                schema.nodes.hardBreak!.create(),
                schema.text('wrap2'),
            ]),
        ]);

        expect(getEditorText(createEditorFromDoc(doc))).toBe('para1\nwrap1\npara2\nwrap2');
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

    it('preserves hard breaks while filtering mixed inline search tags', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.text('before'),
                schema.nodes.hardBreak!.create(),
                schema.nodes.attachmentTag!.create({ attachmentId: 'file-1' }),
                schema.text('after'),
            ]),
        ]);

        expect(getEditorText(createEditorFromDoc(doc))).toBe('before\nafter');
    });
});
