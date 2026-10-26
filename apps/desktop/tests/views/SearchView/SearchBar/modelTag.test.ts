// Side-effect import: the tag registry only knows the tag nodes once their modules registered.
import '@/views/SearchView/components/SearchBar/tags';

import type { Editor } from '@tiptap/core';
import { Editor as VueEditor } from '@tiptap/vue-3';
import { afterEach, describe, expect, it } from 'vitest';

import {
    clearEditorPreservingModelTag,
    getModelTag,
    insertModelTag,
    removeModelTag,
} from '@/views/SearchView/components/SearchBar/tags/model';
import {
    createSearchEditorExtensions,
    getEditorText,
} from '@/views/SearchView/components/SearchBar/utils/tiptap';

/**
 * The model chip is a real ProseMirror node, so these tests build the same editor
 * the search bar builds and read the resulting document. The chip's position,
 * its attributes and what survives a clear are all observable in the editor state.
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

function docWithModelTag(text = 'hello') {
    return {
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [
                    {
                        type: 'modelTag',
                        attrs: { modelId: 'gpt-5', modelName: 'GPT-5', providerId: 7 },
                    },
                    { type: 'text', text },
                ],
            },
        ],
    };
}

function modelTagNodes(editor: Editor) {
    const found: Array<{ name: string; attrs: Record<string, unknown>; pos: number }> = [];
    editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'modelTag') {
            found.push({ name: node.type.name, attrs: node.attrs, pos });
        }
        return true;
    });
    return found;
}

afterEach(() => {
    for (const editor of openEditors.splice(0)) {
        editor.destroy();
    }

    document.body.innerHTML = '';
});

describe('when the page reads the selected model out of the draft', () => {
    it('user gets no model reported when the draft holds only text', () => {
        const editor = createEditor({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'just text' }] }],
        });

        expect(getModelTag(editor)).toBeNull();
    });

    it('user gets the model attributes of the chip in the draft', () => {
        const editor = createEditor(docWithModelTag());

        expect(getModelTag(editor)).toEqual({
            modelId: 'gpt-5',
            modelName: 'GPT-5',
            providerId: 7,
        });
    });

    it('user gets the model reported even when the chip is not the first node', () => {
        const editor = createEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'before ' },
                        {
                            type: 'modelTag',
                            attrs: { modelId: 'sonnet', modelName: 'Sonnet', providerId: 2 },
                        },
                    ],
                },
            ],
        });

        // The lookup must not depend on the chip sitting at a fixed position.
        expect(getModelTag(editor)?.modelId).toBe('sonnet');
    });
});

describe('when the user picks a model', () => {
    it('user gets the chip added at the front of an empty draft', () => {
        const editor = createEditor();

        insertModelTag(editor, { modelId: 'gpt-5', modelName: 'GPT-5', providerId: 7 });

        const tags = modelTagNodes(editor);
        expect(tags).toHaveLength(1);
        expect(tags[0]!.pos).toBe(1);
        expect(tags[0]!.attrs.modelId).toBe('gpt-5');
    });

    it('user gets the chip replaced rather than duplicated when switching models', () => {
        const editor = createEditor(docWithModelTag());

        insertModelTag(editor, { modelId: 'sonnet', modelName: 'Sonnet', providerId: 2 });

        const tags = modelTagNodes(editor);
        expect(tags).toHaveLength(1);
        expect(tags[0]!.attrs.modelId).toBe('sonnet');
        // The draft text next to the chip must survive the swap.
        expect(getEditorText(editor)).toBe('hello');
    });

    it('user gets the caret placed right after the new chip so typing continues in the draft', () => {
        const editor = createEditor();

        insertModelTag(editor, { modelId: 'gpt-5', modelName: 'GPT-5', providerId: 7 });

        // The chip is one position wide, so text starts at 2.
        expect(editor.state.selection.from).toBe(2);
        expect(editor.state.selection.empty).toBe(true);
    });

    it('user gets the chip text readable in the draft as the model name', () => {
        const editor = createEditor();

        insertModelTag(editor, { modelId: 'gpt-5', modelName: 'GPT-5', providerId: 7 });

        // The chip renders its label, which is what the user sees before the text.
        expect(editor.view.dom.textContent).toContain('GPT-5');
    });
});

describe('when the page removes the model chip', () => {
    it('user gets the chip gone and the draft text kept', () => {
        const editor = createEditor(docWithModelTag());

        removeModelTag(editor);

        expect(modelTagNodes(editor)).toHaveLength(0);
        expect(getEditorText(editor)).toBe('hello');
    });

    it('user gets no crash when there is no chip to remove', () => {
        const editor = createEditor({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }],
        });

        expect(() => removeModelTag(editor)).not.toThrow();
        expect(getEditorText(editor)).toBe('plain');
    });

    it('user gets only the first chip removed when the draft somehow holds two', () => {
        const editor = createEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'modelTag', attrs: { modelId: 'first', modelName: 'First' } },
                        { type: 'text', text: 'mid ' },
                        { type: 'modelTag', attrs: { modelId: 'second', modelName: 'Second' } },
                    ],
                },
            ],
        });

        removeModelTag(editor);

        const tags = modelTagNodes(editor);
        expect(tags).toHaveLength(1);
        // The removal stops at the first match instead of sweeping the draft.
        expect(tags[0]!.attrs.modelId).toBe('second');
    });
});

describe('when the page clears the draft but keeps the chosen model', () => {
    it('user keeps the model chip and loses the typed text', () => {
        const editor = createEditor(docWithModelTag('draft text'));

        clearEditorPreservingModelTag(editor);

        expect(modelTagNodes(editor)).toHaveLength(1);
        expect(getModelTag(editor)?.modelId).toBe('gpt-5');
        expect(getEditorText(editor)).toBe('');
    });

    it('user keeps the chip attributes intact through the clear', () => {
        const editor = createEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: 'modelTag',
                            attrs: { modelId: 'sonnet', modelName: 'Sonnet', providerId: 2 },
                        },
                        { type: 'text', text: 'hello' },
                    ],
                },
            ],
        });

        clearEditorPreservingModelTag(editor);

        expect(getModelTag(editor)).toEqual({
            modelId: 'sonnet',
            modelName: 'Sonnet',
            providerId: 2,
        });
    });

    it('user gets a plain empty draft when no model was ever chosen', () => {
        const editor = createEditor({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'no model here' }] }],
        });

        clearEditorPreservingModelTag(editor);

        // Without a chip the clear has nothing to preserve, so the draft just empties.
        expect(getEditorText(editor)).toBe('');
        expect(modelTagNodes(editor)).toHaveLength(0);
        expect(editor.state.doc.childCount).toBe(1);
    });

    it('user gets the caret at the end after the clear so typing continues', () => {
        const editor = createEditor(docWithModelTag('draft text'));

        clearEditorPreservingModelTag(editor);

        expect(editor.state.selection.from).toBeGreaterThanOrEqual(2);
        expect(editor.commands.focus).toBeTypeOf('function');
    });
});

describe('when the model tag is copied out as HTML', () => {
    it('user gets the model id and name carried in the copied chip markup', () => {
        const editor = createEditor(docWithModelTag());

        const chip = editor.view.dom.querySelector('[data-model-tag]') as HTMLElement;

        expect(chip).not.toBeNull();
        expect(chip.getAttribute('data-model-id')).toBe('gpt-5');
        expect(chip.textContent).toContain('GPT-5');
    });

    it('user gets no id attribute leaked when the chip has no model id', () => {
        const editor = createEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'modelTag', attrs: { modelId: null, modelName: '' } }],
                },
            ],
        });

        const chip = editor.view.dom.querySelector('[data-model-tag]') as HTMLElement;

        // An empty attribute is written as an empty string, never the literal "null".
        expect(chip.getAttribute('data-model-id')).toBe('');
    });
});
