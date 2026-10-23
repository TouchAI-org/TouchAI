// Side-effect import: the tag registry only recognises nodes whose plugins registered themselves.
import '@/views/SearchView/components/SearchBar/tags';

import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection, type Transaction } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';

import {
    clearEditorSkipSync,
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
 * A schema that mirrors the production editor: paragraphs, text, hard breaks and
 * the two atom tag nodes. Tag nodes have to be registered with the tag registry
 * for the keyboard and selection helpers to recognise them.
 */
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

/**
 * The production helpers read `state`, `view` and `commands` only. This mock keeps a
 * real EditorState so ProseMirror's own selection and transaction logic runs for real,
 * and widens `state` because the tests set it directly instead of dispatching.
 */
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
            // Mirrors tiptap: a command callback that returns true gets its transaction applied.
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
            setContent: vi.fn((json: unknown) => {
                void json;
            }),
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

/** The helpers under test accept a tiptap Editor; the mock carries the same surface. */
function createEditor(
    doc: ReturnType<typeof schema.node>,
    options: Parameters<typeof createMockEditor>[1] = {}
): Editor {
    return createMockEditor(doc, options) as unknown as Editor;
}

/** Casts the structural mock to the tiptap Editor the helpers expect. */
function asEditor(editor: MockEditor): Editor {
    return editor as unknown as Editor;
}

function paragraphWithText(text: string) {
    return schema.nodes.paragraph!.create(null, [schema.text(text)]);
}

function emptyParagraph() {
    return schema.nodes.paragraph!.create(null, []);
}

describe('when the editor holds plain text', () => {
    it('user sees the text recognised as plain so it can be restored without tags', () => {
        const doc = schema.nodes.doc!.create(null, [paragraphWithText('hello world')]);

        expect(isPlainText(createEditor(doc))).toBe(true);
    });

    it('user sees a model tag make the content non-plain so the structured snapshot is used', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.nodes.modelTag!.create({ modelId: 'gpt-5', modelName: 'GPT-5' }),
                schema.text('hello'),
            ]),
        ]);

        expect(isPlainText(createEditor(doc))).toBe(false);
    });

    it('user sees a hard break make the content non-plain so the line breaks survive a restore', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.text('line one'),
                schema.nodes.hardBreak!.create(),
                schema.text('line two'),
            ]),
        ]);

        expect(isPlainText(createEditor(doc))).toBe(false);
    });
});

describe('when the caret sits at a document boundary', () => {
    it('user gets the start reported when the caret is before the first character', () => {
        const doc = schema.nodes.doc!.create(null, [paragraphWithText('hello')]);
        const editor = createEditor(doc, { selection: { from: 1 } });

        expect(isCursorAtDocStart(editor)).toBe(true);
        expect(isCursorAtDocEnd(editor)).toBe(false);
    });

    it('user gets the end reported when the caret is after the last character', () => {
        const doc = schema.nodes.doc!.create(null, [paragraphWithText('hello')]);
        const editor = createEditor(doc, { selection: { from: 6 } });

        expect(isCursorAtDocEnd(editor)).toBe(true);
        expect(isCursorAtDocStart(editor)).toBe(false);
    });

    it('user gets the text start reported right after the leading model tag', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.nodes.modelTag!.create({ modelId: 'gpt-5' }),
                schema.text('hello'),
            ]),
        ]);

        // The tag occupies position 1..2, so the text starts at position 2.
        const atTextStart = createEditor(doc, { selection: { from: 2 } });
        expect(isCursorAtTextStart(atTextStart)).toBe(true);

        const insideText = createEditor(doc, { selection: { from: 4 } });
        expect(isCursorAtTextStart(insideText)).toBe(false);
    });

    it('user gets the text start fall back to the document start when there is no model tag', () => {
        const doc = schema.nodes.doc!.create(null, [paragraphWithText('hello')]);
        const editor = createEditor(doc, { selection: { from: 1 } });

        expect(isCursorAtTextStart(editor)).toBe(true);
    });
});

describe('when the user presses ArrowUp at the top of the draft', () => {
    function docWithLeadingModelTag() {
        return schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.nodes.modelTag!.create({ modelId: 'gpt-5' }),
                schema.text('hello world'),
            ]),
            schema.nodes.paragraph!.create(null, [schema.text('second line')]),
        ]);
    }

    it('user gets the caret moved to the text start instead of before the model tag', () => {
        const editor = createEditor(docWithLeadingModelTag(), {
            selection: { from: 3 },
            endOfTextblock: () => true,
        });

        expect(handleArrowUpNearTextStart(editor)).toBe(true);
        expect(editor.state.selection.from).toBe(2);
    });

    it('user gets the caret moved off a selected model tag', () => {
        const editor = createEditor(docWithLeadingModelTag(), { nodeSelectionAt: 1 });

        expect(handleArrowUpNearTextStart(editor)).toBe(true);
        expect(editor.state.selection.from).toBe(2);
    });

    it('user gets the caret moved to the text start when a selection starts before it', () => {
        const editor = createEditor(docWithLeadingModelTag(), {
            selection: { from: 1, to: 3 },
        });

        expect(handleArrowUpNearTextStart(editor)).toBe(true);
        expect(editor.state.selection.from).toBe(2);
    });

    it('user keeps normal ArrowUp behaviour when the caret is on a later line of the same paragraph', () => {
        const editor = createEditor(docWithLeadingModelTag(), {
            selection: { from: 3 },
            endOfTextblock: () => false,
        });

        expect(handleArrowUpNearTextStart(editor)).toBe(false);
    });

    it('user keeps normal ArrowUp behaviour in later paragraphs', () => {
        const editor = createEditor(docWithLeadingModelTag(), {
            selection: { from: 20 },
            endOfTextblock: () => true,
        });

        expect(handleArrowUpNearTextStart(editor)).toBe(false);
    });

    it('user keeps normal ArrowUp behaviour when there is no model tag at all', () => {
        const doc = schema.nodes.doc!.create(null, [paragraphWithText('hello')]);
        const editor = createEditor(doc, { selection: { from: 3 } });

        expect(handleArrowUpNearTextStart(editor)).toBe(false);
    });

    it('user keeps normal ArrowUp behaviour when the caret is already after the text start', () => {
        const editor = createEditor(docWithLeadingModelTag(), {
            selection: { from: 5 },
            endOfTextblock: () => false,
        });

        expect(handleArrowUpNearTextStart(editor)).toBe(false);
    });
});

describe('when the user replaces the whole draft with plain text', () => {
    it('user sees one paragraph per line so the line breaks survive', () => {
        const doc = schema.nodes.doc!.create(null, [paragraphWithText('old')]);
        const editor = createEditor(doc);

        setEditorText(editor, 'first line\n\nthird line');

        const setContent = editor.commands.setContent as unknown as ReturnType<typeof vi.fn>;
        expect(setContent).toHaveBeenCalledWith({
            type: 'doc',
            content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'first line' }] },
                { type: 'paragraph' },
                { type: 'paragraph', content: [{ type: 'text', text: 'third line' }] },
            ],
        });
    });

    it('user gets the draft cleared when the replacement text is empty', () => {
        const doc = schema.nodes.doc!.create(null, [paragraphWithText('old')]);
        const editor = createEditor(doc);

        setEditorText(editor, '');

        expect(editor.commands.clearContent).toHaveBeenCalledWith(true);
        expect(editor.commands.setContent).not.toHaveBeenCalled();
    });
});

describe('when the app clears the editor without telling the user', () => {
    it('user does not get a tag removal event for a programmatic clear', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.nodes.modelTag!.create({ modelId: 'gpt-5' }),
                schema.text('hello'),
            ]),
        ]);
        const editor = createEditor(doc);

        expect(clearEditorSkipSync(editor)).toBeUndefined();

        // The document was emptied through a transaction carrying the skip marker,
        // so the tag sync plugin will not treat this as a user removal.
        expect(editor.state.doc.textContent).toBe('');
    });
});

describe('when the user pastes text with line breaks', () => {
    it('user gets nothing inserted for whitespace-free empty input', () => {
        const doc = schema.nodes.doc!.create(null, [paragraphWithText('before')]);
        const editor = createEditor(doc, { selection: { from: 7 } });

        expect(insertPlainTextAtSelection(editor, '')).toBe(false);
        expect(getEditorText(editor)).toBe('before');
    });

    it('user gets Windows and classic Mac line endings normalised to one newline', () => {
        const doc = schema.nodes.doc!.create(null, [emptyParagraph()]);
        const editor = createEditor(doc, { selection: { from: 1 } });

        expect(insertPlainTextAtSelection(editor, 'a\r\nb\rc')).toBe(true);

        expect(getEditorText(editor)).toBe('a\nb\nc');
    });

    it('user gets leading blank lines preserved when pasting a block that starts with a newline', () => {
        const doc = schema.nodes.doc!.create(null, [emptyParagraph()]);
        const editor = createEditor(doc, { selection: { from: 1 } });

        expect(insertPlainTextAtSelection(editor, '\nindented')).toBe(true);

        expect(getEditorText(editor)).toBe('\nindented');
    });
});

describe('when the user clicks inside the editor', () => {
    function createClickEditor(posAtDOM?: number | (() => number)) {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.text('before '),
                schema.nodes.attachmentTag!.create({ attachmentId: 'file-1' }),
                schema.text(' after'),
            ]),
        ]);

        return createMockEditor(doc, {
            posAtDOM: typeof posAtDOM === 'function' ? posAtDOM : () => posAtDOM ?? 0,
        });
    }

    it('user gets the clicked tag selected so it can be deleted or replaced', () => {
        const editor = createClickEditor(8);
        const chip = document.createElement('span');
        chip.setAttribute('data-search-tag', '');
        document.body.appendChild(chip);

        const event = {
            target: chip,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        } as unknown as MouseEvent;

        handleEditorClick(asEditor(editor), event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(editor.state.selection).toBeInstanceOf(NodeSelection);

        chip.remove();
    });

    it('user gets no selection change when clicking ordinary text', () => {
        const editor = createClickEditor();
        const text = document.createElement('p');
        text.textContent = 'before';
        document.body.appendChild(text);

        const before = editor.state.selection.from;
        const event = { target: text } as unknown as MouseEvent;

        handleEditorClick(asEditor(editor), event);

        expect(editor.state.selection.from).toBe(before);

        text.remove();
    });

    it('user keeps an in-progress text selection when clicking a tag, so dragging still works', () => {
        const editor = createClickEditor();
        const chip = document.createElement('span');
        chip.setAttribute('data-search-tag', '');
        document.body.appendChild(chip);

        const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 5));
        editor.state = editor.state.apply(tr);

        const event = {
            target: chip,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        } as unknown as MouseEvent;

        handleEditorClick(asEditor(editor), event);

        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(editor.state.selection).toBeInstanceOf(TextSelection);

        chip.remove();
    });

    it('user gets the tag under the caret found when the click lands just after it', () => {
        // Position 9 is right after the attachment chip, inside the following text.
        const editor = createClickEditor(9);
        const chip = document.createElement('span');
        chip.setAttribute('data-search-tag', '');
        document.body.appendChild(chip);

        // A position right after the atom: nodeAt returns nothing, so the helper
        // falls back to the node before the caret.

        const event = {
            target: chip,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        } as unknown as MouseEvent;

        handleEditorClick(asEditor(editor), event);

        expect(editor.state.selection).toBeInstanceOf(NodeSelection);

        chip.remove();
    });

    it('user gets no tag selected when the click lands on text rather than a tag node', () => {
        const editor = createClickEditor(1);
        const chip = document.createElement('span');
        chip.setAttribute('data-search-tag', '');
        document.body.appendChild(chip);

        const event = {
            target: chip,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        } as unknown as MouseEvent;

        handleEditorClick(asEditor(editor), event);

        expect(editor.state.selection).not.toBeInstanceOf(NodeSelection);

        chip.remove();
    });

    it('user gets no crash when the editor cannot resolve the clicked position', () => {
        const editor = createClickEditor(() => {
            throw new Error('position outside document');
        });
        const chip = document.createElement('span');
        chip.setAttribute('data-search-tag', '');
        document.body.appendChild(chip);

        const event = {
            target: chip,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        } as unknown as MouseEvent;

        expect(() => handleEditorClick(asEditor(editor), event)).not.toThrow();

        chip.remove();
    });
});

describe('when the model tag is not the first node', () => {
    it('user keeps normal ArrowUp behaviour because there is no leading tag boundary', () => {
        const doc = schema.nodes.doc!.create(null, [
            schema.nodes.paragraph!.create(null, [
                schema.text('text first'),
                schema.nodes.modelTag!.create({ modelId: 'gpt-5' }),
            ]),
        ]);
        const editor = createEditor(doc, { selection: { from: 3 }, endOfTextblock: () => true });

        expect(handleArrowUpNearTextStart(editor)).toBe(false);
    });
});
