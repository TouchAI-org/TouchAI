import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';

import {
    getEditorText,
    insertPlainTextAtSelection,
} from '@/views/SearchView/components/SearchBar/utils/tiptap';

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

function createCommandEditorFromDoc(
    doc: ReturnType<typeof schema.node>,
    selection?: { from: number; to?: number }
): Editor {
    const editor = {
        state: EditorState.create({
            schema,
            doc,
        }),
        view: {
            dispatch: (tr: Transaction) => {
                editor.state = editor.state.apply(tr);
            },
        },
        commands: {
            command: (
                callback: (props: {
                    state: EditorState;
                    dispatch?: (tr: Transaction) => void;
                }) => boolean
            ) => {
                return callback({
                    state: editor.state,
                    dispatch: editor.view.dispatch,
                });
            },
        },
    };

    if (selection) {
        const tr = editor.state.tr.setSelection(
            TextSelection.create(editor.state.doc, selection.from, selection.to ?? selection.from)
        );
        editor.state = editor.state.apply(tr);
    }

    return editor as Editor;
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

    it('inserts pasted plain text without flattening line breaks', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [schema.text('before ')]),
        ]);
        const editor = createCommandEditorFromDoc(doc, { from: 1 + 'before '.length });

        expect(insertPlainTextAtSelection(editor, 'Python\t动态\r\nRust\t静态')).toBe(true);

        expect(getEditorText(editor)).toBe('before Python\t动态\nRust\t静态');
    });

    it('replaces selected text while preserving consecutive line breaks', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [schema.text('left OLD right')]),
        ]);
        const editor = createCommandEditorFromDoc(doc, {
            from: 1 + 'left '.length,
            to: 1 + 'left OLD'.length,
        });

        expect(insertPlainTextAtSelection(editor, 'X\n\nY')).toBe(true);

        expect(getEditorText(editor)).toBe('left X\n\nY right');
    });
});
