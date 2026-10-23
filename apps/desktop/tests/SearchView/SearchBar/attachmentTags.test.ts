// Side-effect import: the tag registry only recognises nodes whose plugins registered themselves.
import '@/views/SearchView/components/SearchBar/tags';

import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';

import {
    getAttachmentTags,
    insertAttachmentTag,
    removeAttachmentTag,
    updateAttachmentTag,
    updateAttachmentTagsSupport,
} from '@/views/SearchView/components/SearchBar/tags/attachment';

const schema = new Schema({
    nodes: {
        doc: { content: 'block+' },
        paragraph: {
            content: 'inline*',
            group: 'block',
            parseDOM: [{ tag: 'p' }],
            toDOM: () => ['p', 0],
        },
        text: { group: 'inline' },
        hardBreak: {
            group: 'inline',
            inline: true,
            selectable: false,
            parseDOM: [{ tag: 'br' }],
            toDOM: () => ['br'],
        },
        modelTag: {
            group: 'inline',
            inline: true,
            atom: true,
            selectable: true,
            attrs: {
                modelId: { default: null },
                modelName: { default: null },
                providerId: { default: null },
            },
            toDOM: () => ['span', { 'data-search-tag': '' }],
        },
        attachmentTag: {
            group: 'inline',
            inline: true,
            atom: true,
            selectable: true,
            attrs: {
                attachmentId: { default: null },
                alias: { default: null },
                fileName: { default: null },
                fileType: { default: 'file' },
                preview: { default: null },
                supportStatus: { default: 'supported' },
            },
            toDOM: () => ['span', { 'data-search-tag': '' }],
        },
    },
});

/**
 * The tests drive a real EditorState directly. tiptap types `state` as read-only
 * because production code must go through a transaction, so the mock widens it.
 */
interface MutableEditorState {
    state: EditorState;
    commands: Record<string, unknown>;
    focus: () => void;
}

function createAttachmentAttrs(id: string, overrides: Record<string, unknown> = {}) {
    return {
        attachmentId: id,
        alias: `A1-${id}`,
        fileName: `${id}.txt`,
        fileType: 'file' as const,
        ...overrides,
    };
}

/**
 * Builds an editor whose `chain()` mirrors tiptap: each queued command receives the
 * shared transaction, and `run()` applies it when every command succeeded.
 */
function createChainEditor(
    doc: ReturnType<typeof schema.node>,
    options: { selection?: { from: number; to?: number } } = {}
): MutableEditorState & Editor {
    const editor = {
        state: EditorState.create({ schema, doc }),
        focus: vi.fn(),
        chain() {
            const callbacks: Array<(props: { tr: Transaction; state: EditorState }) => boolean> =
                [];
            const chain = {
                focus: () => chain,
                command: (
                    callback: (props: { tr: Transaction; state: EditorState }) => boolean
                ) => {
                    callbacks.push(callback);
                    return chain;
                },
                run: () => {
                    const tr = editor.state.tr;
                    const allApplied = callbacks.every((callback) =>
                        callback({ tr, state: editor.state })
                    );
                    if (allApplied) {
                        editor.state = editor.state.apply(tr);
                    }
                    return allApplied;
                },
            };
            return chain;
        },
    } as unknown as MutableEditorState & Editor;

    if (options.selection) {
        const tr = editor.state.tr.setSelection(
            TextSelection.create(
                editor.state.doc,
                options.selection.from,
                options.selection.to ?? options.selection.from
            )
        );
        editor.state = editor.state.apply(tr);
    }

    return editor;
}

function createCommandEditor(
    doc: ReturnType<typeof schema.node>,
    options: { selection?: { from: number; to?: number } } = {}
): MutableEditorState & Editor {
    const editor = {
        state: EditorState.create({ schema, doc }),
        commands: {
            command: (callback: (props: { tr: Transaction; state: EditorState }) => boolean) => {
                const tr = editor.state.tr;
                const applied = callback({ tr, state: editor.state });
                if (applied) {
                    editor.state = editor.state.apply(tr);
                }
                return applied;
            },
        },
    } as unknown as MutableEditorState & Editor;

    if (options.selection) {
        const tr = editor.state.tr.setSelection(
            TextSelection.create(
                editor.state.doc,
                options.selection.from,
                options.selection.to ?? options.selection.from
            )
        );
        editor.state = editor.state.apply(tr);
    }

    return editor;
}

function paragraphWithText(text: string) {
    return schema.nodes.paragraph!.create(null, [schema.text(text)]);
}

function attachmentNode(id: string, overrides: Record<string, unknown> = {}) {
    return schema.nodes.attachmentTag!.create({
        attachmentId: id,
        alias: `A1-${id}`,
        fileName: `${id}.txt`,
        fileType: 'file',
        ...overrides,
    });
}

describe('when the user attaches a file at the caret', () => {
    it('user sees the attachment chip appear right after the caret', () => {
        const doc = schema.nodes.doc!.create(null, [paragraphWithText('hello ')]);
        const editor = createChainEditor(doc, { selection: { from: 7 } });

        insertAttachmentTag(editor, createAttachmentAttrs('doc-1'));

        const tags = getAttachmentTags(editor);
        expect(tags).toHaveLength(1);
        expect(tags[0]).toMatchObject({ attachmentId: 'doc-1', fileName: 'doc-1.txt' });
    });

    it('user sees the replaced text when attaching over a selection', () => {
        const doc = schema.nodes.doc!.create(null, [paragraphWithText('left OLD right')]);
        const editor = createChainEditor(doc, {
            selection: { from: 6, to: 9 },
        });

        insertAttachmentTag(editor, createAttachmentAttrs('image-1', { fileType: 'image' }), {
            atCurrentSelection: true,
        });

        const paragraph = editor.state.doc.child(0);
        expect(paragraph.textContent).toBe('left  right');
        expect(paragraph.child(1)?.type.name).toBe('attachmentTag');
        expect(paragraph.child(1)?.attrs.attachmentId).toBe('image-1');
    });

    it('user sees the chip land at the original clipboard position for a pasted mixed payload', () => {
        const doc = schema.nodes.doc!.create(null, [paragraphWithText('before after')]);
        // The caret is at the end; the pasted attachment belongs after "before ".
        const editor = createChainEditor(doc, { selection: { from: 13 } });

        insertAttachmentTag(editor, createAttachmentAttrs('clip-1'), { textOffset: 7 });

        const paragraph = editor.state.doc.child(0);
        // The chip sits between "before " and "after", not after the caret at the end.
        expect(paragraph.child(1)?.type.name).toBe('attachmentTag');
        expect(paragraph.child(1)?.attrs.attachmentId).toBe('clip-1');
        expect(paragraph.textContent).toBe('before after');
    });

    it('user gets several images pasted at one offset kept in their original order', () => {
        const doc = schema.nodes.doc!.create(null, [paragraphWithText('before after')]);
        const editor = createChainEditor(doc, { selection: { from: 13 } });

        insertAttachmentTag(editor, createAttachmentAttrs('img-1', { fileType: 'image' }), {
            textOffset: 7,
            sameOffsetIndex: 0,
        });
        insertAttachmentTag(editor, createAttachmentAttrs('img-2', { fileType: 'image' }), {
            textOffset: 7,
            sameOffsetIndex: 1,
        });

        const paragraph = editor.state.doc.child(0);
        expect(paragraph.child(1)?.attrs.attachmentId).toBe('img-1');
        expect(paragraph.child(2)?.attrs.attachmentId).toBe('img-2');
    });

    it('user gets the chip appended at the very end for a pasted offset beyond the draft', () => {
        const doc = schema.nodes.doc!.create(null, [paragraphWithText('short')]);
        const editor = createChainEditor(doc, { selection: { from: 6 } });

        insertAttachmentTag(editor, createAttachmentAttrs('far-1'), { textOffset: 9_999 });

        expect(getAttachmentTags(editor).map((tag) => tag.attachmentId)).toEqual(['far-1']);
    });

    it('user gets the chip placed across paragraphs using the merged plain text offsets', () => {
        const doc = schema.nodes.doc!.create(null, [
            paragraphWithText('first'),
            paragraphWithText('second'),
        ]);
        const editor = createChainEditor(doc, { selection: { from: 1 } });

        // The merged text is "first\nsecond"; offset 7 lands inside the second paragraph.
        insertAttachmentTag(editor, createAttachmentAttrs('para-1'), { textOffset: 7 });

        const secondParagraph = editor.state.doc.child(1);
        expect(secondParagraph.textContent).toContain('second');
        expect(getAttachmentTags(editor)).toHaveLength(1);
    });

    it('user gets the chip placed at a paragraph boundary for a pasted offset on the newline', () => {
        const doc = schema.nodes.doc!.create(null, [
            paragraphWithText('first'),
            paragraphWithText('second'),
        ]);
        const editor = createChainEditor(doc, { selection: { from: 1 } });

        // Offset 5 is exactly the newline between the two paragraphs.
        insertAttachmentTag(editor, createAttachmentAttrs('boundary-1'), { textOffset: 5 });

        expect(getAttachmentTags(editor)).toHaveLength(1);
    });
});

describe('when the user removes an attachment chip', () => {
    it('user sees only the removed chip disappear', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                attachmentNode('keep-1'),
                schema.text(' text '),
                attachmentNode('drop-1'),
            ]),
        ]);
        const editor = createCommandEditor(doc);

        removeAttachmentTag(editor, 'drop-1');

        expect(getAttachmentTags(editor).map((tag) => tag.attachmentId)).toEqual(['keep-1']);
    });

    it('user sees nothing change when removing a chip that is not there', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [attachmentNode('keep-1')]),
        ]);
        const editor = createCommandEditor(doc);

        removeAttachmentTag(editor, 'missing');

        expect(getAttachmentTags(editor)).toHaveLength(1);
    });

    it('user sees the chip metadata updated in place, keeping its position', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.text('before '),
                attachmentNode('doc-1'),
                schema.text(' after'),
            ]),
        ]);
        const editor = createCommandEditor(doc);

        updateAttachmentTag(editor, {
            ...createAttachmentAttrs('doc-1'),
            alias: 'A2-doc-1',
            fileName: 'renamed.txt',
        });

        const paragraph = editor.state.doc.child(0);
        expect(paragraph.child(1)?.attrs.alias).toBe('A2-doc-1');
        expect(paragraph.child(1)?.attrs.fileName).toBe('renamed.txt');
        expect(paragraph.textContent).toBe('before  after');
    });

    it('user gets no change when updating a chip that is not there', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [attachmentNode('keep-1')]),
        ]);
        const editor = createCommandEditor(doc);

        updateAttachmentTag(editor, { ...createAttachmentAttrs('missing'), alias: 'A9-missing' });

        expect(getAttachmentTags(editor)[0]?.alias).toBe('A1-keep-1');
    });
});

describe('when the user switches to a model with different capabilities', () => {
    it('user sees an image chip greyed out when the model cannot read images', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [attachmentNode('img-1', { fileType: 'image' })]),
        ]);
        const editor = createCommandEditor(doc);

        updateAttachmentTagsSupport(editor, { supportsImages: false, supportsFiles: true });

        expect(getAttachmentTags(editor)[0]?.supportStatus).toBe('unsupported-image');
    });

    it('user sees a file chip greyed out when the model cannot read files', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [attachmentNode('doc-1', { fileType: 'file' })]),
        ]);
        const editor = createCommandEditor(doc);

        updateAttachmentTagsSupport(editor, { supportsImages: true, supportsFiles: false });

        expect(getAttachmentTags(editor)[0]?.supportStatus).toBe('unsupported-file');
    });

    it('user sees both chips enabled again when switching back to a capable model', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                attachmentNode('img-1', {
                    fileType: 'image',
                    supportStatus: 'unsupported-image',
                }),
                attachmentNode('doc-1', {
                    fileType: 'file',
                    supportStatus: 'unsupported-file',
                }),
            ]),
        ]);
        const editor = createCommandEditor(doc);

        updateAttachmentTagsSupport(editor, { supportsImages: true, supportsFiles: true });

        expect(getAttachmentTags(editor).map((tag) => tag.supportStatus)).toEqual([
            'supported',
            'supported',
        ]);
    });

    it('user gets no document change when every chip already matches the capabilities', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                attachmentNode('img-1', { fileType: 'image', supportStatus: 'supported' }),
            ]),
        ]);
        const editor = createCommandEditor(doc);
        const before = editor.state.doc;

        updateAttachmentTagsSupport(editor, { supportsImages: true, supportsFiles: true });

        // An unchanged document means no redundant transaction for the editor.
        expect(editor.state.doc).toBe(before);
    });
});

describe('when the draft already contains attachment chips', () => {
    it('user gets every chip reported with the metadata the chip needs to render', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                attachmentNode('img-1', {
                    fileType: 'image',
                    preview: 'data:image/png;base64,abc',
                }),
                attachmentNode('doc-1'),
            ]),
        ]);

        const tags = getAttachmentTags(createCommandEditor(doc));

        expect(tags).toEqual([
            {
                attachmentId: 'img-1',
                alias: 'A1-img-1',
                fileName: 'img-1.txt',
                fileType: 'image',
                preview: 'data:image/png;base64,abc',
                supportStatus: 'supported',
            },
            {
                attachmentId: 'doc-1',
                alias: 'A1-doc-1',
                fileName: 'doc-1.txt',
                fileType: 'file',
                preview: undefined,
                supportStatus: 'supported',
            },
        ]);
    });

    it('user gets no chips reported for a draft without attachments', () => {
        const doc = schema.nodes.doc!.create(null, [paragraphWithText('just text')]);

        expect(getAttachmentTags(createCommandEditor(doc))).toEqual([]);
    });
});
