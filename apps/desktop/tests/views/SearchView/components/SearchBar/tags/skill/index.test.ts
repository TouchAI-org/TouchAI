import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { getSkillTags, insertSkillTag } from '@/views/SearchView/components/SearchBar/tags/skill';
import {
    createSearchEditorExtensions,
    getEditorText,
} from '@/views/SearchView/components/SearchBar/utils/tiptap';

const skill = { name: 'summary', path: '/skills/summary/SKILL.md' };
let editor: Editor;
function open(text = 'Before $sum after') {
    editor = new Editor({
        extensions: createSearchEditorExtensions({}),
        content: `<p>${text}</p>`,
    });
    return editor;
}
afterEach(() => {
    editor?.destroy();
});

describe('given a draft contains a skill trigger', () => {
    it('user replaces the trigger in one undoable edit and preserves surrounding text', () => {
        open();
        editor.commands.setTextSelection(12);
        insertSkillTag(editor, skill, '$sum');
        expect(getSkillTags(editor)).toEqual([skill]);
        expect(getEditorText(editor)).toBe('Before  after');
        editor.commands.undo();
        expect(getSkillTags(editor)).toEqual([]);
        expect(getEditorText(editor)).toBe('Before $sum after');
    });
    it('user keeps the draft intact when the cursor no longer points to the trigger', () => {
        open();
        editor.commands.setTextSelection(3);
        insertSkillTag(editor, skill, '$sum');
        expect(getSkillTags(editor)).toEqual([]);
        expect(getEditorText(editor)).toBe('Before $sum after');
    });
    it('user replaces a selected text range with the chosen skill', () => {
        open('select this');
        editor.commands.setTextSelection({ from: 1, to: 7 });
        insertSkillTag(editor, skill);
        expect(getEditorText(editor)).toBe(' this');
        expect(getSkillTags(editor)).toEqual([skill]);
    });
    it('user gets one selected skill identity when a tag is pasted twice', () => {
        open('');
        insertSkillTag(editor, skill);
        insertSkillTag(editor, skill);
        expect(getSkillTags(editor)).toEqual([skill]);
    });
    it('user can copy and restore the skill tag as editor HTML', () => {
        open('');
        insertSkillTag(editor, skill);
        const html = editor.getHTML();
        editor.commands.setContent(html);
        expect(getSkillTags(editor)).toEqual([skill]);
    });
    it.each(['Backspace', 'Delete'])(
        'user given a selected skill when pressing %s then removes only the skill and can undo',
        (key) => {
            open(
                'Before <span data-skill-tag name="summary" path="/skills/summary/SKILL.md">summary</span> after'
            );
            editor.commands.setNodeSelection(8);

            editor.commands.keyboardShortcut(key);

            expect(getSkillTags(editor)).toEqual([]);
            expect(getEditorText(editor)).toBe('Before  after');
            editor.commands.undo();
            expect(getSkillTags(editor)).toEqual([skill]);
            expect(getEditorText(editor)).toBe('Before  after');
        }
    );
});
