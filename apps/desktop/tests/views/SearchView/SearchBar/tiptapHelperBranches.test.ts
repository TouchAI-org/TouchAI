// Side-effect import: the tag registry only knows the tag nodes once their modules registered.
import '@/views/SearchView/components/SearchBar/tags';

import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection, type Transaction } from '@tiptap/pm/state';
import { Editor as VueEditor } from '@tiptap/vue-3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createSearchEditorExtensions,
    getEditorText,
    handleArrowUpNearTextStart,
    handleEditorClick,
    insertPlainTextAtSelection,
    isCursorAtDocEnd,
    isCursorAtDocStart,
    isCursorAtTextStart,
    isPlainText,
    setEditorText,
} from '@/views/SearchView/components/SearchBar/utils/tiptap';

/**
 * Branch pass over the editor helpers. The real-Editor cases use the production
 * extension list; the selection-edge cases need a document shape the search bar
 * never builds (a non-paragraph block, a selection that starts before the leading
 * chip), so they drive a small explicit schema through the same public helpers.
 */
const openEditors: Editor[] = [];

function createEditor(content?: unknown): Editor {
    const editor = new VueEditor({
        extensions: createSearchEditorExtensions({}),
        content: (content as never) ?? { type: 'doc', content: [{ type: 'paragraph' }] },
    }) as Editor;

    openEditors.push(editor);
    return editor;
}

function docWithLeadingModelTag(text = 'hello') {
    return {
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [
                    { type: 'modelTag', attrs: { modelId: 'gpt-5', modelName: 'GPT-5' } },
                    { type: 'text', text },
                ],
            },
        ],
    };
}

/** A minimal schema mirroring the editor, used for the selection-edge cases. */
const schema = new Schema({
    nodes: {
        doc: { content: 'block+' },
        paragraph: {
            content: 'inline*',
            group: 'block',
            parseDOM: [{ tag: 'p' }],
            toDOM: () => ['p', 0],
        },
        blockquote: {
            content: 'paragraph+',
            group: 'block',
            parseDOM: [{ tag: 'blockquote' }],
            toDOM: () => ['blockquote', 0],
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
            toDOM: () => ['span', { 'data-search-tag': '', 'data-model-tag': '' }],
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
            },
            toDOM: () => ['span', { 'data-search-tag': '' }],
        },
    },
});

interface CommandProps {
    state: EditorState;
    tr: Transaction;
    dispatch?: (tr: Transaction) => void;
}

interface MockEditor {
    state: EditorState;
    view: {
        dispatch: (tr: Transaction) => void;
        dom: HTMLElement;
        posAtDOM: (node: Node, offset: number) => number;
        focus: () => void;
        endOfTextblock?: (direction: string) => boolean;
    };
    commands: Record<string, unknown> & {
        command: (callback: (props: CommandProps) => boolean) => boolean;
    };
}

function createMockEditor(
    doc: ReturnType<typeof schema.node>,
    options: {
        selection?: { from: number; to?: number };
        nodeSelectionAt?: number;
        endOfTextblock?: (direction: string) => boolean;
        posAtDOM?: () => number;
    } = {}
): MockEditor {
    const editor: MockEditor = {
        state: EditorState.create({ schema, doc }),
        view: {
            dispatch: (tr: Transaction) => {
                editor.state = editor.state.apply(tr);
            },
            dom: document.createElement('div'),
            posAtDOM: vi.fn(options.posAtDOM ?? (() => 0)),
            focus: vi.fn(),
            endOfTextblock: options.endOfTextblock ?? (() => false),
        },
        commands: {
            command: (callback: (props: CommandProps) => boolean) => {
                const tr = editor.state.tr;
                let dispatched = false;
                const applied = callback({
                    state: editor.state,
                    tr,
                    dispatch: (nextTr: Transaction) => {
                        dispatched = true;
                        editor.state = editor.state.apply(nextTr);
                    },
                });
                if (applied && !dispatched) {
                    editor.state = editor.state.apply(tr);
                }
                return applied;
            },
            setContent: vi.fn(),
            clearContent: vi.fn(),
            focus: vi.fn(),
            setHardBreak: vi.fn(() => true),
        },
    };

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

    if (options.nodeSelectionAt !== undefined) {
        const tr = editor.state.tr.setSelection(
            NodeSelection.create(editor.state.doc, options.nodeSelectionAt)
        );
        editor.state = editor.state.apply(tr);
    }

    return editor;
}

function asEditor(editor: MockEditor): Editor {
    return editor as unknown as Editor;
}

afterEach(() => {
    for (const editor of openEditors.splice(0)) {
        editor.destroy();
    }

    document.body.innerHTML = '';
});

describe('when the draft mixes text with a hard break', () => {
    it('user gets the content treated as non-plain so the structure is kept', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.text('line one'),
                schema.nodes.hardBreak!.create(),
            ]),
        ]);

        expect(isPlainText(asEditor(createMockEditor(doc)))).toBe(false);
    });

    it('user gets plain text reported for a draft of several paragraphs', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [schema.text('one')]),
            schema.nodes.paragraph!.create(null, [schema.text('two')]),
        ]);

        // Several paragraphs are still plain: no custom nodes are involved.
        expect(isPlainText(asEditor(createMockEditor(doc)))).toBe(true);
    });
});

describe('when the caret sits at a boundary in a nested block', () => {
    it('user gets no document start reported when the caret is inside a nested block', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.blockquote!.create(null, [
                schema.nodes.paragraph!.create(null, [schema.text('nested')]),
            ]),
        ]);

        const editor = createMockEditor(doc, { selection: { from: 3 } });

        expect(isCursorAtDocStart(asEditor(editor))).toBe(false);
    });

    it('user gets no text start reported when a nested block has no leading model chip', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.blockquote!.create(null, [
                schema.nodes.paragraph!.create(null, [schema.text('nested')]),
            ]),
        ]);

        // No leading chip means the text start falls back to position 1.
        const editor = createMockEditor(doc, { selection: { from: 1 } });

        expect(isCursorAtTextStart(asEditor(editor))).toBe(true);
    });

    it('user gets the end reported for a caret at the very end of a nested block', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.blockquote!.create(null, [
                schema.nodes.paragraph!.create(null, [schema.text('nested')]),
            ]),
        ]);
        const end = TextSelection.atEnd(doc).to;
        const editor = createMockEditor(doc, { selection: { from: end } });

        expect(isCursorAtDocEnd(asEditor(editor))).toBe(true);
    });
});

describe('when the user presses ArrowUp with a selection that starts before the chip', () => {
    it('user gets the caret pulled to the text start', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.nodes.modelTag!.create({ modelId: 'gpt-5', modelName: 'GPT-5' }),
                schema.text('hello world'),
            ]),
        ]);
        // Selection starts at the chip and reaches into the text.
        const editor = createMockEditor(doc, { selection: { from: 1, to: 4 } });

        expect(handleArrowUpNearTextStart(asEditor(editor))).toBe(true);
        expect(editor.state.selection.from).toBe(2);
    });

    it('user gets normal ArrowUp behaviour when the selection sits entirely after the chip', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.nodes.modelTag!.create({ modelId: 'gpt-5', modelName: 'GPT-5' }),
                schema.text('hello world'),
            ]),
        ]);
        const editor = createMockEditor(doc, {
            selection: { from: 4, to: 7 },
            endOfTextblock: () => true,
        });

        // The selection never touches the chip, so the boundary rule does not apply.
        expect(handleArrowUpNearTextStart(asEditor(editor))).toBe(false);
    });
});

describe('when the user pastes plain text into a draft', () => {
    it('user gets nothing inserted for a string of only line breaks with no text', () => {
        const doc = schema.nodes.doc!.create(null, [schema.nodes.paragraph!.create(null, [])]);
        const editor = createMockEditor(doc, { selection: { from: 1 } });

        // A hard break is still a node, so the newline survives as a break.
        expect(insertPlainTextAtSelection(asEditor(editor), '\n')).toBe(true);
        expect(getEditorText(asEditor(editor))).toBe('\n');
    });

    it('user gets the pasted text replacing an active selection', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [schema.text('replace me')]),
        ]);
        // "replace me" occupies positions 1..11, so select the whole phrase.
        const editor = createMockEditor(doc, { selection: { from: 1, to: 11 } });

        expect(insertPlainTextAtSelection(asEditor(editor), 'done')).toBe(true);
        expect(getEditorText(asEditor(editor))).toBe('done');
    });

    it('user gets a single-line paste appended without a line break', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [schema.text('start')]),
        ]);
        const editor = createMockEditor(doc, { selection: { from: 6 } });

        expect(insertPlainTextAtSelection(asEditor(editor), ' end')).toBe(true);
        expect(getEditorText(asEditor(editor))).toBe('start end');
    });
});

describe('when the editor is replaced with a plain-text draft', () => {
    it('user gets an empty draft back for an empty string', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [schema.text('old')]),
        ]);
        const editor = createMockEditor(doc);

        setEditorText(asEditor(editor), '');

        expect(editor.commands.clearContent).toHaveBeenCalledWith(true);
    });
});

describe('when the user clicks a chip in a real editor', () => {
    it('user gets the chip selected when the click lands on its close button', () => {
        const editor = createEditor(docWithLeadingModelTag());
        const close = editor.view.dom.querySelector('[data-tag-close]') as HTMLElement;
        expect(close).not.toBeNull();

        const event = {
            target: close,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        } as unknown as MouseEvent;

        handleEditorClick(editor, event);

        expect(editor.state.selection).toBeInstanceOf(NodeSelection);
        expect(event.preventDefault).toHaveBeenCalled();
    });

    it('user gets no selection change when the click has no resolvable target', () => {
        const editor = createEditor(docWithLeadingModelTag());
        const before = editor.state.selection.from;

        handleEditorClick(editor, { target: null } as unknown as MouseEvent);

        expect(editor.state.selection.from).toBe(before);
    });
});

describe('when the user presses Shift+Enter in a draft that already has content', () => {
    it('user gets a hard break instead of a new paragraph', () => {
        const editor = createEditor(docWithLeadingModelTag('some text'));
        editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' more');

        editor.view.dom.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            })
        );

        // With content present the break stays inside the paragraph.
        expect(editor.state.doc.childCount).toBe(1);
        expect(getEditorText(editor)).toContain('\n');
    });
});
