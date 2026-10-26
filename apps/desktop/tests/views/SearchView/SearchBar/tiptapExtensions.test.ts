// Side-effect import: the tag registry only knows the tag nodes once their modules registered.
import '@/views/SearchView/components/SearchBar/tags';

import type { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { Editor as VueEditor } from '@tiptap/vue-3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { t } from '@/i18n';
import {
    clearEditorSkipSync,
    createSearchEditorExtensions,
    DEFAULT_PLACEHOLDER_KEY,
    getEditorText,
    handleEditorClick,
    setEditorText,
} from '@/views/SearchView/components/SearchBar/utils/tiptap';

/**
 * These tests drive a real Tiptap editor built from the same extension list the
 * search bar uses. The behaviour under test (Enter, Shift+Enter, arrows,
 * Backspace, chip selection) only exists inside that wiring: the shortcuts come
 * from `SearchKeyboard`, the chips from the tag registry and the range highlight
 * from the decoration plugin. A stubbed editor would assert none of it.
 */
const openEditors: Editor[] = [];

function createEditor(
    content?: unknown,
    options: { onTagRemoved?: (tagName: string, id: string) => void; placeholder?: string } = {}
): Editor {
    const editor = new VueEditor({
        extensions: createSearchEditorExtensions({
            placeholder: options.placeholder,
            onTagRemoved: options.onTagRemoved,
        }),
        content: (content as never) ?? { type: 'doc', content: [{ type: 'paragraph' }] },
    }) as Editor;

    openEditors.push(editor);
    return editor;
}

function press(editor: Editor, key: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
    });
    editor.view.dom.dispatchEvent(event);
    return event;
}

function placeCaret(editor: Editor, position: number) {
    editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position))
    );
}

function selectRange(editor: Editor, from: number, to: number) {
    editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to))
    );
}

function selectNode(editor: Editor, position: number) {
    editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position))
    );
}

function docWithLeadingModelTag(text = 'hello') {
    return {
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [
                    {
                        type: 'modelTag',
                        attrs: { modelId: 'gpt-5', modelName: 'GPT-5', providerId: 1 },
                    },
                    { type: 'text', text },
                ],
            },
        ],
    };
}

function docWithAttachmentTag() {
    return {
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'before ' },
                    {
                        type: 'attachmentTag',
                        attrs: {
                            attachmentId: 'file-1',
                            alias: 'A1',
                            fileName: 'notes.txt',
                            fileType: 'file',
                        },
                    },
                    { type: 'text', text: ' after' },
                ],
            },
        ],
    };
}

function chipOf(editor: Editor) {
    return editor.view.dom.querySelector('[data-search-tag]') as HTMLElement;
}

function clickChip(editor: Editor) {
    const event = {
        target: chipOf(editor),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    } as unknown as MouseEvent;

    handleEditorClick(editor, event);
    return event;
}

afterEach(() => {
    for (const editor of openEditors.splice(0)) {
        editor.destroy();
    }

    document.body.innerHTML = '';
});

describe('when the search bar builds its editor', () => {
    it('user sees the translated placeholder in an empty search box', () => {
        const editor = createEditor();

        const placeholder = editor.view.dom
            .querySelector('[data-placeholder]')
            ?.getAttribute('data-placeholder');

        expect(placeholder).toBe(t(DEFAULT_PLACEHOLDER_KEY));
    });

    it('user sees the placeholder text the search bar asked for', () => {
        const editor = createEditor(undefined, { placeholder: 'Search or ask anything' });

        const placeholder = editor.view.dom
            .querySelector('[data-placeholder]')
            ?.getAttribute('data-placeholder');

        expect(placeholder).toBe('Search or ask anything');
    });

    it('user sees the placeholder disappear as soon as the draft has text', () => {
        const editor = createEditor();
        expect(editor.view.dom.querySelector('[data-placeholder]')).not.toBeNull();

        editor.commands.insertContent('hello');

        expect(editor.view.dom.querySelector('[data-placeholder]')).toBeNull();
    });
});

describe('when the user presses Enter in the search box', () => {
    it('user stays on one line so the outer handler can submit the prompt', () => {
        const editor = createEditor();
        editor.commands.insertContent('hello');

        const event = press(editor, 'Enter');

        expect(event.defaultPrevented).toBe(true);
        expect(editor.state.doc.childCount).toBe(1);
        expect(getEditorText(editor)).toBe('hello');
    });

    it('user gets a new line in an empty search box when pressing Shift+Enter', () => {
        const editor = createEditor();

        const event = press(editor, 'Enter', { shiftKey: true });

        expect(event.defaultPrevented).toBe(true);
        expect(editor.state.doc.childCount).toBe(2);
        expect(getEditorText(editor)).toBe('\n');
        // The caret has to sit in the new line so the user can keep typing there.
        expect(editor.state.selection.from).toBe(3);
    });

    it('user gets a line break inside the same paragraph when pressing Shift+Enter after typing', () => {
        const editor = createEditor();
        editor.commands.insertContent('first');

        press(editor, 'Enter', { shiftKey: true });

        expect(editor.state.doc.childCount).toBe(1);
        expect(getEditorText(editor)).toBe('first\n');
    });
});

describe('when the user moves the caret around the model chip', () => {
    it('user gets the caret placed left of the chip when pressing ArrowLeft right after it', () => {
        const editor = createEditor(docWithLeadingModelTag());
        placeCaret(editor, 2);

        const event = press(editor, 'ArrowLeft');

        expect(event.defaultPrevented).toBe(true);
        expect(editor.state.selection.from).toBe(1);
        expect(editor.state.selection.empty).toBe(true);
    });

    it('user gets the caret placed right of the chip when pressing ArrowRight before it', () => {
        const editor = createEditor(docWithLeadingModelTag());
        placeCaret(editor, 1);

        const event = press(editor, 'ArrowRight');

        expect(event.defaultPrevented).toBe(true);
        expect(editor.state.selection.from).toBe(2);
    });

    it('user keeps the browser moving the caret when pressing ArrowRight inside the text', () => {
        const editor = createEditor(docWithLeadingModelTag());
        placeCaret(editor, 3);

        const event = press(editor, 'ArrowRight');

        // Not intercepted: the browser moves the caret one character.
        expect(event.defaultPrevented).toBe(false);
    });

    it('user gets the caret at the chip edge when the chip is selected and an arrow is pressed', () => {
        const editor = createEditor(docWithLeadingModelTag());

        selectNode(editor, 1);
        press(editor, 'ArrowLeft');
        expect(editor.state.selection.from).toBe(1);
        expect(editor.state.selection.empty).toBe(true);

        selectNode(editor, 1);
        press(editor, 'ArrowRight');
        expect(editor.state.selection.from).toBe(2);
        expect(editor.state.selection.empty).toBe(true);
    });

    it('user gets a selection around the chip when pressing Shift+ArrowLeft right after it', () => {
        const editor = createEditor(docWithLeadingModelTag());
        placeCaret(editor, 2);

        const event = press(editor, 'ArrowLeft', { shiftKey: true });

        expect(event.defaultPrevented).toBe(true);
        expect(editor.state.selection.from).toBe(1);
        expect(editor.state.selection.to).toBe(2);
    });

    it('user gets a selection around the chip when pressing Shift+ArrowRight before it', () => {
        const editor = createEditor(docWithLeadingModelTag());
        placeCaret(editor, 1);

        const event = press(editor, 'ArrowRight', { shiftKey: true });

        expect(event.defaultPrevented).toBe(true);
        expect(editor.state.selection.from).toBe(1);
        expect(editor.state.selection.to).toBe(2);
    });

    it('user gets the chip highlighted while the dragged selection crosses it', () => {
        const editor = createEditor(docWithLeadingModelTag());

        expect(editor.view.dom.querySelector('.search-tag-range-selected')).toBeNull();

        selectRange(editor, 1, 4);

        expect(editor.view.dom.querySelector('.search-tag-range-selected')).not.toBeNull();
    });

    it('user stops seeing the chip highlighted once the selection collapses', () => {
        const editor = createEditor(docWithLeadingModelTag());
        selectRange(editor, 1, 4);
        expect(
            editor.view.dom.querySelectorAll('.search-tag-range-selected').length
        ).toBeGreaterThan(0);

        placeCaret(editor, 3);

        expect(editor.view.dom.querySelector('.search-tag-range-selected')).toBeNull();
    });
});

describe('when the user presses ArrowUp at the start of the draft', () => {
    it('user gets the caret moved to the text start instead of before the chip', () => {
        const editor = createEditor(docWithLeadingModelTag('hello world'));
        placeCaret(editor, 12);

        const event = press(editor, 'ArrowUp');

        expect(event.defaultPrevented).toBe(true);
        expect(editor.state.selection.from).toBe(2);
    });
});

describe('when the user presses Backspace next to a chip', () => {
    it('user gets the chip deleted when the caret sits right after it', () => {
        const onTagRemoved = vi.fn();
        const editor = createEditor(docWithAttachmentTag(), { onTagRemoved });
        // Position 9 is the caret right after the attachment chip.
        placeCaret(editor, 9);

        press(editor, 'Backspace');

        expect(onTagRemoved).toHaveBeenCalledWith('attachmentTag', 'file-1');
        expect(getEditorText(editor)).toBe('before  after');
    });

    it('user gets the selected chip deleted when the chip itself is selected', () => {
        const onTagRemoved = vi.fn();
        const editor = createEditor(docWithLeadingModelTag(), { onTagRemoved });
        selectNode(editor, 1);

        press(editor, 'Backspace');

        expect(onTagRemoved).toHaveBeenCalledWith('modelTag', 'gpt-5');
        expect(editor.state.doc.child(0).childCount).toBe(1);
        expect(getEditorText(editor)).toBe('hello');
    });

    it('user keeps the chip when Backspace is pressed in the middle of the text', () => {
        const onTagRemoved = vi.fn();
        const editor = createEditor(docWithAttachmentTag(), { onTagRemoved });
        placeCaret(editor, 3);

        press(editor, 'Backspace');

        expect(onTagRemoved).not.toHaveBeenCalled();
        expect(editor.state.doc.child(0).childCount).toBe(3);
    });
});

describe('when the app clears or replaces the draft without the user', () => {
    it('user gets no attachment removal reported for a programmatic clear', () => {
        const onTagRemoved = vi.fn();
        const editor = createEditor(docWithAttachmentTag(), { onTagRemoved });

        clearEditorSkipSync(editor);

        expect(getEditorText(editor)).toBe('');
        expect(onTagRemoved).not.toHaveBeenCalled();
    });

    it('user gets the dropped chip reported when the draft is replaced wholesale', () => {
        const onTagRemoved = vi.fn();
        const editor = createEditor(docWithAttachmentTag(), { onTagRemoved });

        setEditorText(editor, 'replaced from the page');

        // The attachment no longer exists in the draft, so the page has to drop it too.
        expect(getEditorText(editor)).toBe('replaced from the page');
        expect(onTagRemoved).toHaveBeenCalledWith('attachmentTag', 'file-1');
    });
});

describe('when the page restores a draft into the search box', () => {
    it('user sees one line per paragraph and gets the draft back unchanged', () => {
        const editor = createEditor();

        setEditorText(editor, 'first line\n\nthird line');
        expect(getEditorText(editor)).toBe('first line\n\nthird line');

        setEditorText(editor, '');
        expect(getEditorText(editor)).toBe('');
        expect(editor.state.doc.childCount).toBe(1);
    });
});

describe('when the user clicks the rendered model chip', () => {
    it('user gets the chip selected so it can be deleted or replaced', () => {
        const editor = createEditor(docWithLeadingModelTag());

        const event = clickChip(editor);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(editor.state.selection).toBeInstanceOf(NodeSelection);
        expect(editor.state.selection.from).toBe(1);
    });

    it('user keeps their text selection when the click lands on the chip mid-drag', () => {
        const editor = createEditor(docWithLeadingModelTag());
        selectRange(editor, 2, 4);

        const event = clickChip(editor);

        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(editor.state.selection).not.toBeInstanceOf(NodeSelection);
    });
});
