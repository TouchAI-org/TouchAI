import { installSkillCommands } from '@tests/utils/skills';
import { mockTauriCommand } from '@tests/utils/tauri';
import { EditorContent } from '@tiptap/vue-3';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';

import SearchBar from '@/views/SearchView/components/SearchBar/index.vue';

const SearchInput = defineComponent({
    components: { SearchBar },
    setup: () => ({ query: ref('') }),
    template: '<SearchBar v-model:query-text="query" :start-dragging="async () => {}" />',
});
const rangeDescriptors = ['getClientRects', 'getBoundingClientRect'].map((name) => ({
    name,
    descriptor: Object.getOwnPropertyDescriptor(Range.prototype, name),
}));
const caretDescriptor = Object.getOwnPropertyDescriptor(document, 'caretRangeFromPoint');
let wrapper: VueWrapper | undefined;

beforeEach(() => {
    installSkillCommands();
    mockTauriCommand('database_query', { rows: [], rowsAffected: 0, lastInsertId: null });
    // JSDOM has no text geometry, but the editor and its selection transactions are real.
    Object.defineProperties(Range.prototype, {
        getClientRects: { configurable: true, value: () => [] },
        getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
});

afterEach(async () => {
    await new Promise(requestAnimationFrame);
    wrapper?.unmount();
    for (const { name, descriptor } of rangeDescriptors) {
        if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
        else Reflect.deleteProperty(Range.prototype, name);
    }
    if (caretDescriptor) Object.defineProperty(document, 'caretRangeFromPoint', caretDescriptor);
    else Reflect.deleteProperty(document, 'caretRangeFromPoint');
});

async function open(draft: string) {
    wrapper = mount(SearchInput, {
        attachTo: document.body,
        global: { plugins: [createPinia()] },
    });
    await flushPromises();
    const input = wrapper.getComponent(SearchBar);
    const editor = wrapper.getComponent(EditorContent).props('editor')!;
    editor.view.focus();
    input.vm.insertTextAtCursor(draft);
    await flushPromises();
    return { input, editor, paragraph: wrapper.get('.ProseMirror p') };
}

describe('given an existing draft in the real search editor', () => {
    it.each(['.ProseMirror', '.ProseMirror p'])(
        'user given the right-hand blank area in %s when clicking then focuses and continues at the end',
        async (selector) => {
            const { input, editor, paragraph } = await open('Hello world');
            editor.commands.setTextSelection(4);
            editor.view.dom.blur();
            const elementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
            Object.defineProperty(document, 'elementFromPoint', {
                configurable: true,
                value: () => paragraph.element,
            });
            Object.defineProperty(document, 'caretRangeFromPoint', {
                configurable: true,
                value: () => ({ startContainer: paragraph.element.firstChild, startOffset: 11 }),
            });
            try {
                const target = wrapper!.get(selector);
                await target.trigger('mousedown', { button: 0, clientX: 300, clientY: 10 });
                window.dispatchEvent(new MouseEvent('mouseup', { clientX: 300, clientY: 10 }));
                await target.trigger('click', { clientX: 300, clientY: 10 });
                await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
                input.vm.insertTextAtCursor('!');
                expect(input.vm.captureInputHistorySnapshot().text).toBe('Hello world!');
            } finally {
                if (elementFromPoint)
                    Object.defineProperty(document, 'elementFromPoint', elementFromPoint);
                else Reflect.deleteProperty(document, 'elementFromPoint');
            }
        }
    );

    it.each([
        ['Hello world', 6, 'Hello! world'],
        ['请帮我修改这段文字', 4, '请帮我!修改这段文字'],
        ['First line\nSecond line', 7, 'First !line\nSecond line'],
    ])(
        'user given %j when clicking in the middle then keeps that caret and inserts at the clicked position',
        async (draft, position, expected) => {
            const { input, editor, paragraph } = await open(draft);
            // A browser places the native caret on mousedown, before click bubbles to the host.
            editor.commands.setTextSelection(position);
            Object.defineProperty(document, 'caretRangeFromPoint', {
                configurable: true,
                value: () => ({ startContainer: paragraph.element.firstChild, startOffset: 1 }),
            });

            await paragraph.trigger('click', { clientX: 80, clientY: 20 });
            await new Promise(requestAnimationFrame);
            await flushPromises();

            expect(editor.state.selection.from).toBe(position);
            expect(document.activeElement).toBe(editor.view.dom);
            input.vm.insertTextAtCursor('!');
            expect(input.vm.captureInputHistorySnapshot().text).toBe(expected);
        }
    );

    it('user given selected text when releasing the pointer then keeps the selection and replaces only that text', async () => {
        const { input, editor, paragraph } = await open('Hello world');
        editor.commands.setTextSelection({ from: 7, to: 12 });
        Object.defineProperty(document, 'caretRangeFromPoint', {
            configurable: true,
            value: () => ({ startContainer: paragraph.element.firstChild, startOffset: 11 }),
        });

        await paragraph.trigger('click', { clientX: 110, clientY: 20 });
        await new Promise(requestAnimationFrame);

        expect(editor.state.selection.from).toBe(7);
        expect(editor.state.selection.to).toBe(12);
        input.vm.insertTextAtCursor('there');
        expect(input.vm.captureInputHistorySnapshot().text).toBe('Hello there');
    });

    it('user given an existing draft when clicking the outer blank editor area then can continue at the end', async () => {
        const { input, editor } = await open('Hello world');
        editor.commands.setTextSelection(4);
        editor.view.dom.blur();

        await wrapper!.get('[data-testid="search-editor-host"]').trigger('click');
        await new Promise(requestAnimationFrame);

        expect(document.activeElement).toBe(editor.view.dom);
        input.vm.insertTextAtCursor('!');
        expect(input.vm.captureInputHistorySnapshot().text).toBe('Hello world!');
    });
});
