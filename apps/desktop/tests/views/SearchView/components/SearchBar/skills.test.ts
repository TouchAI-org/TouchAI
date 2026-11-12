import { installSkillCommands, skillFile, widgetSkillFile } from '@tests/utils/skills';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { EditorContent } from '@tiptap/vue-3';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';

import { setLocale } from '@/i18n';
import type { InputHistorySnapshot } from '@/types/session';
import SearchBar from '@/views/SearchView/components/SearchBar/index.vue';
import SkillPickerPanel from '@/views/SearchView/components/SearchBar/SkillPickerPanel.vue';

type SearchInput = {
    insertTextAtCursor: (text: string) => void;
    insertSkillAtCursor: (skill: { name: string; path: string }) => void;
    insertAttachmentAtCursor: (id: string, name: string, type: 'file') => void;
    captureInputHistorySnapshot: () => InputHistorySnapshot;
    restoreInputHistorySnapshot: (snapshot: InputHistorySnapshot) => string;
};
let wrapper: VueWrapper;
let input: VueWrapper<SearchInput>;
const SearchWithResults = defineComponent({
    components: { SearchBar, SkillPickerPanel },
    props: {
        pickerMaxHeight: { type: Number, default: 320 },
        compact: { type: Boolean, default: false },
        completeFile: { type: Function, default: undefined },
        startDragging: { type: Function, default: () => Promise.resolve() },
    },
    setup() {
        return { query: ref('') };
    },
    template: `<div><SearchBar v-model:query-text="query" :start-dragging="startDragging" :complete-file="completeFile" :auto-select-first="compact" :show-empty-results="compact">
        <template #results="{ skillPicker, selectSkill }">
            <SkillPickerPanel v-if="skillPicker" :picker="skillPicker" :max-height="pickerMaxHeight" :compact="compact"
                @select="selectSkill" />
        </template>
    </SearchBar></div>`,
});
const rangeDescriptors = ['getClientRects', 'getBoundingClientRect'].map((name) => ({
    name,
    descriptor: Object.getOwnPropertyDescriptor(Range.prototype, name),
}));

beforeEach(() => {
    setLocale('en-US');
    installSkillCommands();
    mockTauriCommand('database_query', { rows: [], rowsAffected: 0, lastInsertId: null });
    // JSDOM has no layout engine; ProseMirror still uses the browser Range geometry API.
    Object.defineProperty(Range.prototype, 'getClientRects', {
        configurable: true,
        value: () => [],
    });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: () => new DOMRect(),
    });
});

afterEach(async () => {
    await new Promise(requestAnimationFrame);
    wrapper?.unmount();
    for (const { name, descriptor } of rangeDescriptors) {
        if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
        else Reflect.deleteProperty(Range.prototype, name);
    }
});

function lastSkillInputActiveChange() {
    const events = input.emitted('skillInputActiveChange') ?? [];
    return events[events.length - 1];
}

function pickerShortcutKeys() {
    return wrapper
        .get('[data-testid="skill-picker-panel"]')
        .findAll('kbd')
        .map((key) => key.text());
}

async function open(completeFile?: () => null) {
    wrapper = mount(SearchWithResults, {
        attachTo: document.body,
        props: { completeFile },
        global: { plugins: [createPinia()] },
    });
    input = wrapper.findComponent(SearchBar) as unknown as VueWrapper<SearchInput>;
    await flushPromises();
    wrapper.get<HTMLElement>('.ProseMirror').element.focus();
    await flushPromises();
    return wrapper;
}

describe('given a caret scroll is queued while the input is closing', () => {
    it('user closes the input before the next frame without a delayed editor error', async () => {
        await open();
        const callbacks: FrameRequestCallback[] = [];
        const animationFrame = vi
            .spyOn(window, 'requestAnimationFrame')
            .mockImplementation((fn) => {
                callbacks.push(fn);
                return callbacks.length;
            });
        try {
            input.vm.insertTextAtCursor('/sum');
            wrapper.unmount();

            expect(callbacks.length).toBeGreaterThan(0);
            expect(() => callbacks.forEach((callback) => callback(0))).not.toThrow();
        } finally {
            animationFrame.mockRestore();
        }
    });
});

describe('given blank space to the right of the input text', () => {
    it.each(['', 'Existing draft'])(
        'user clicks after %j with minor pointer jitter and continues typing without dragging the window',
        async (draft) => {
            await open();
            const startDragging = vi.fn().mockResolvedValue(undefined);
            await wrapper.setProps({ startDragging });
            input.vm.insertTextAtCursor(draft);
            const editor = wrapper.getComponent(EditorContent).props('editor')!;
            editor.commands.setTextSelection(1);
            editor.view.dom.blur();
            const host = wrapper.get<HTMLElement>('[data-testid="search-editor-host"]');
            const descriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
            Object.defineProperty(document, 'elementFromPoint', {
                configurable: true,
                value: () => host.element,
            });
            try {
                await host.trigger('mousedown', { button: 0, clientX: 300, clientY: 10 });
                window.dispatchEvent(
                    new MouseEvent('mousemove', {
                        clientX: 302,
                        clientY: 11,
                        buttons: 1,
                    })
                );
                window.dispatchEvent(new MouseEvent('mouseup', { clientX: 302, clientY: 11 }));
                await host.trigger('click', { clientX: 302, clientY: 11 });
                await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
                input.vm.insertTextAtCursor('next');
                expect(startDragging).not.toHaveBeenCalled();
                expect(input.vm.captureInputHistorySnapshot().text).toBe(`${draft}next`);
            } finally {
                if (descriptor) Object.defineProperty(document, 'elementFromPoint', descriptor);
                else Reflect.deleteProperty(document, 'elementFromPoint');
            }
        }
    );
});

describe.each(['$', '/'])('given the main input starts a skill query with %s', (prefix) => {
    it.each([
        ['en-US', 'Global', 'App', 'Built-in'],
        ['zh-CN', '全局', '应用', '内置'],
    ] as const)(
        'user given skills from every source when completing in %s then sees a source label beside each skill',
        async (locale, sharedLabel, appLabel, builtInLabel) => {
            setLocale(locale);
            installSkillCommands(
                [skillFile('global-example'), skillFile('app-example', false, 'app')],
                [widgetSkillFile()]
            );
            await open();
            input.vm.insertTextAtCursor(prefix);
            await flushPromises();
            for (const [name, label] of [
                ['global-example', sharedLabel],
                ['app-example', appLabel],
                ['widget', builtInLabel],
            ]) {
                expect(wrapper.get(`[role="option"][title="${name}"]`).text()).toContain(label);
            }
        }
    );
    it.each(['', ' after'])(
        'user given a skill query before %j when completing it then continues after one separator',
        async (suffix) => {
            await open();
            input.vm.insertTextAtCursor(`${prefix}sum${suffix}`);
            const editor = wrapper.getComponent(EditorContent).props('editor')!;
            editor.commands.setTextSelection(5);
            await flushPromises();
            await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
            await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
            await flushPromises();
            expect(
                editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\ufffc')
            ).toBe(`\ufffc ${suffix.trimStart()}`);
            expect(editor.state.selection.$from.nodeBefore?.text).toBe(' ');
            input.vm.insertTextAtCursor('next');
            expect(
                editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\ufffc')
            ).toBe(`\ufffc next${suffix.trimStart()}`);
        }
    );

    it('user given a skill query before a line break when completing it then keeps the line break without an extra space', async () => {
        await open();
        input.vm.restoreInputHistorySnapshot({ text: `${prefix}sum\nafter`, attachments: [] });
        const editor = wrapper.getComponent(EditorContent).props('editor')!;
        editor.commands.setTextSelection(5);
        await flushPromises();
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        expect(input.vm.captureInputHistorySnapshot().text).toBe('\nafter');
        expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');
    });

    it('user given a bundled widget skill when selecting it then sees its built-in label and keeps only the skill identity', async () => {
        installSkillCommands([], [widgetSkillFile()]);
        await open();
        input.vm.insertTextAtCursor(prefix);
        await flushPromises();
        const row = wrapper.get('[data-testid="skill-picker-panel"] [role="option"]');
        expect(row.text()).toContain('Built-in');
        await row.trigger('mousedown');
        await row.trigger('click');
        await flushPromises();
        expect(input.vm.captureInputHistorySnapshot().skills).toEqual([
            { name: 'widget', path: widgetSkillFile().path },
        ]);
        expect(JSON.stringify(input.vm.captureInputHistorySnapshot())).not.toContain('skill_key');
    });
    it.each(['Enter', 'Tab'])(
        'user presses %s with no skill matches and retains skill intent without ordinary file completion',
        async (key) => {
            const completeFile = vi.fn(() => null);
            await open(completeFile);
            input.vm.insertTextAtCursor(`${prefix}sum-missing-skill`);
            await flushPromises();
            const draft = input.vm.captureInputHistorySnapshot();
            const editor = wrapper.get('.ProseMirror');
            expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
            expect(editor.attributes('aria-expanded')).toBe('false');
            expect(editor.attributes('aria-controls')).toBeUndefined();
            expect(lastSkillInputActiveChange()).toEqual([true]);

            const parentKeyDown = vi.fn();
            wrapper.element.addEventListener('keydown', parentKeyDown);
            const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
            editor.element.dispatchEvent(event);
            await flushPromises();

            expect(event.defaultPrevented).toBe(true);
            expect(parentKeyDown).not.toHaveBeenCalled();
            expect(completeFile).not.toHaveBeenCalled();
            expect(document.activeElement).toBe(editor.element);
            expect(input.vm.captureInputHistorySnapshot()).toEqual(draft);
            expect(lastSkillInputActiveChange()).toEqual([true]);

            input.vm.restoreInputHistorySnapshot({ text: `${prefix}sum`, attachments: [] });
            await flushPromises();
            expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(true);
            expect(editor.attributes('aria-expanded')).toBe('true');
            expect(editor.attributes('aria-activedescendant')).toBeUndefined();
            expect(
                wrapper.get('[data-inline-completion]').attributes('data-inline-completion')
            ).toBe('mary');
            expect(completeFile).not.toHaveBeenCalled();
        }
    );

    it.each(['Enter', 'Tab'])(
        'user presses %s before selecting a skill and keeps the draft and editor focus',
        async (key) => {
            await open();
            input.vm.insertTextAtCursor(prefix);
            await flushPromises();
            const draft = input.vm.captureInputHistorySnapshot();
            const editor = wrapper.get('.ProseMirror');
            const parentKeyDown = vi.fn();
            wrapper.element.addEventListener('keydown', parentKeyDown);
            const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });

            editor.element.dispatchEvent(event);
            await flushPromises();

            expect(event.defaultPrevented).toBe(true);
            expect(parentKeyDown).not.toHaveBeenCalled();
            expect(input.vm.captureInputHistorySnapshot()).toEqual(draft);
            expect(document.activeElement).toBe(editor.element);
            expect(wrapper.find('[data-skill-tag]').exists()).toBe(false);
            expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(true);
            expect(wrapper.get('[role="option"]').attributes('aria-selected')).toBe('false');
            expect(editor.attributes('aria-activedescendant')).toBeUndefined();
        }
    );

    it.each(['Tab', 'Enter'])(
        'user given one prefix match when accepting with %s then sees its list row and completes without changing copied or saved text',
        async (key) => {
            await open();
            input.vm.insertTextAtCursor(`${prefix}sum`);
            await flushPromises();
            expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
            expect(wrapper.get('[role="option"]').text()).toContain('summary');
            expect(wrapper.get('.ProseMirror').attributes('aria-expanded')).toBe('true');

            const preview = wrapper.get('[data-inline-completion]');
            expect(preview.attributes('data-inline-completion')).toBe('mary');
            expect(preview.attributes('aria-hidden')).toBe('true');
            const editor = wrapper.getComponent(EditorContent).props('editor')!;
            const snapshot = input.vm.captureInputHistorySnapshot();
            expect(snapshot.text).toBe(`${prefix}sum`);
            expect(JSON.stringify(snapshot.editorDoc)).not.toContain('mary');
            expect(editor.getHTML()).not.toContain('mary');
            expect(editor.view.serializeForClipboard(editor.state.doc.slice(0)).text).toBe(
                `${prefix}sum`
            );

            await wrapper.get('.ProseMirror').trigger('keydown', { key });
            await flushPromises();
            expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
            expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');
        }
    );

    it.each([false, true])(
        'user given a compact picker of %s when typing a fuzzy skill name then sees its match and inserts it without leaving the editor',
        async (compact) => {
            installSkillCommands([skillFile('skill-creator'), skillFile('review')]);
            await open();
            await wrapper.setProps({ compact });
            input.vm.insertTextAtCursor(`${prefix}skillc`);
            await flushPromises();
            const option = wrapper.get('[role="option"]');
            expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
            expect(option.attributes('title')).toBe('skill-creator');
            expect(
                option
                    .findAll('.text-search-match')
                    .map((part) => part.text())
                    .join('')
            ).toBe('skillc');
            expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
            const editor = wrapper.get('.ProseMirror');
            await editor.trigger('keydown', { key: 'ArrowDown' });
            await editor.trigger('keydown', { key: 'Tab' });
            await flushPromises();
            expect(wrapper.get('[data-skill-tag]').text()).toBe('skill-creator');
            expect(document.activeElement).toBe(editor.element);
            expect(input.vm.captureInputHistorySnapshot().text).toBe(' ');
        }
    );

    it('user previews the highlighted completion and dismisses it together with the list', async () => {
        installSkillCommands([skillFile('summary'), skillFile('summarize')]);
        await open();
        input.vm.insertTextAtCursor(`${prefix}sum`);
        await flushPromises();
        const editor = wrapper.get('.ProseMirror');
        const nameAt = (index: number) =>
            wrapper.findAll('[role="option"]')[index]!.attributes('title')!;
        await editor.trigger('keydown', { key: 'ArrowDown' });
        expect(wrapper.get('[data-inline-completion]').attributes('data-inline-completion')).toBe(
            nameAt(0).slice(3)
        );
        await editor.trigger('keydown', { key: 'ArrowDown' });
        expect(wrapper.get('[data-inline-completion]').attributes('data-inline-completion')).toBe(
            nameAt(1).slice(3)
        );
        await editor.trigger('keydown', { key: 'Escape' });
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
        expect(input.vm.captureInputHistorySnapshot().text).toBe(`${prefix}sum`);
    });

    it('user keeps inline completion after blur and hides it during composition while keeping the draft', async () => {
        installSkillCommands([skillFile('summary'), skillFile('summary-extra')]);
        await open();
        input.vm.insertTextAtCursor(`${prefix}sum`);
        await flushPromises();
        const editor = wrapper.get<HTMLElement>('.ProseMirror');
        await editor.trigger('keydown', { key: 'ArrowDown' });
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(true);
        editor.element.blur();
        await flushPromises();
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(true);
        editor.element.focus();
        await flushPromises();
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(true);
        await editor.trigger('compositionstart');
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
        await editor.trigger('keydown', { key: 'Tab', isComposing: true });
        expect(wrapper.find('[data-skill-tag]').exists()).toBe(false);
        await editor.trigger('compositionend');
        await flushPromises();
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
        // WebKit emits the IME confirmation key after compositionend. ProseMirror suppresses it.
        await editor.trigger('keydown', { key: 'Enter', keyCode: 13, isComposing: false });
        expect(wrapper.find('[data-skill-tag]').exists()).toBe(false);
        await editor.trigger('keydown', { key: 'ArrowDown' });
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(true);
        expect(input.vm.captureInputHistorySnapshot().text).toBe(`${prefix}sum`);
    });

    it('user sees suggestions without inline text when the match is in a description or before existing text', async () => {
        await open();
        input.vm.insertTextAtCursor(`${prefix}documents`);
        await flushPromises();
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
        expect(wrapper.get('[role="option"]').text()).toContain('summary');
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
        input.vm.restoreInputHistorySnapshot({ text: `${prefix}sum later`, attachments: [] });
        const editor = wrapper.getComponent(EditorContent).props('editor')!;
        editor.commands.setTextSelection(5);
        await flushPromises();
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
        expect(wrapper.get('[role="option"]').text()).toContain('summary');
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
    });

    it('user removes the preview by selecting text and recalls only the original draft', async () => {
        await open();
        input.vm.insertTextAtCursor(`${prefix}sum`);
        await flushPromises();
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(true);
        const snapshot = input.vm.captureInputHistorySnapshot();
        const editor = wrapper.getComponent(EditorContent).props('editor')!;
        editor.commands.setTextSelection({ from: 1, to: 5 });
        await flushPromises();
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
        input.vm.restoreInputHistorySnapshot(snapshot);
        await flushPromises();
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
        expect(wrapper.get('[data-inline-completion]').attributes('data-inline-completion')).toBe(
            'mary'
        );
        expect(input.vm.captureInputHistorySnapshot().text).toBe(`${prefix}sum`);
        input.vm.insertTextAtCursor('mary');
        await flushPromises();
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
        expect(input.vm.captureInputHistorySnapshot().text).toBe(`${prefix}summary`);
    });

    it('user opens skill suggestions without initializing file search', async () => {
        await open();
        input.vm.insertTextAtCursor(prefix);
        await flushPromises();

        expect(wrapper.get('[role="option"]').text()).toContain('summary');
        expect(lastSkillInputActiveChange()).toEqual([true]);
        expect(getTauriInvokeCalls('quick_search_prepare_index')).toEqual([]);
        expect(getTauriInvokeCalls('quick_search_get_status')).toEqual([]);
    });

    it.each(['skill', 'attachment'] as const)(
        'user selects a skill when typing its trigger immediately after an existing %s tag',
        async (kind) => {
            await open();
            if (kind === 'skill') {
                input.vm.insertSkillAtCursor({ name: 'review', path: '/skills/review/SKILL.md' });
            } else {
                input.vm.insertAttachmentAtCursor('notes', 'notes.txt', 'file');
            }
            input.vm.insertTextAtCursor(`${prefix}sum`);
            await flushPromises();

            expect(
                wrapper.get('[data-inline-completion]').attributes('data-inline-completion')
            ).toBe('mary');
            await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
            await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
            await flushPromises();
            expect(wrapper.get('[data-skill-name="summary"]').text()).toBe('summary');
            expect(wrapper.findAll('[data-search-tag]')).toHaveLength(2);
            expect(input.vm.captureInputHistorySnapshot().text).toBe(' ');
        }
    );

    it('user inserts a matching skill with Tab and captures it with the draft', async () => {
        await open();
        input.vm.insertTextAtCursor(`${prefix}sum`);
        await flushPromises();
        expect(wrapper.get('[data-inline-completion]').attributes('data-inline-completion')).toBe(
            'mary'
        );
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        await flushPromises();

        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
        expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');
        const snapshot = input.vm.captureInputHistorySnapshot();
        expect(snapshot.text.trim()).toBe('');
        expect(snapshot.skills).toEqual([{ name: 'summary', path: skillFile().path }]);
        expect(input.emitted('skillsChange')).toContainEqual([snapshot.skills]);
    });

    it('user replaces only the query at the caret and can undo or restore the selected skill', async () => {
        await open();
        const before = `First ${prefix}sum then `;
        const after = ' afterwards';
        const draft = `${before}${prefix}sum${after}`;
        input.vm.restoreInputHistorySnapshot({ text: draft, attachments: [] });
        await flushPromises();
        const editor = wrapper.getComponent(EditorContent).props('editor')!;
        editor.commands.setTextSelection(before.length + `${prefix}sum`.length + 1);
        await flushPromises();
        expect(wrapper.get('[role="option"]').text()).toContain('summary');

        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        await flushPromises();

        const selected = input.vm.captureInputHistorySnapshot();
        expect(selected.text).toBe(`${before}${after}`);
        expect(selected.skills).toEqual([{ name: 'summary', path: skillFile().path }]);
        expect(document.activeElement).toBe(wrapper.get('.ProseMirror').element);

        editor.commands.undo();
        await flushPromises();
        expect(input.vm.captureInputHistorySnapshot().text).toBe(draft);
        expect(input.vm.captureInputHistorySnapshot().skills ?? []).toEqual([]);

        input.vm.restoreInputHistorySnapshot(selected);
        await flushPromises();
        expect(input.vm.captureInputHistorySnapshot()).toEqual(selected);
        expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');
    });

    it('user accepts inside a skill name and replaces the entire token without leaving its suffix', async () => {
        await open();
        const before = 'Before ';
        const after = ' after';
        const draft = `${before}${prefix}summary${after}`;
        input.vm.restoreInputHistorySnapshot({ text: draft, attachments: [] });
        await flushPromises();
        const editor = wrapper.getComponent(EditorContent).props('editor')!;
        editor.commands.setTextSelection(before.length + `${prefix}sum`.length + 1);
        await flushPromises();
        expect(wrapper.get('[role="option"]').text()).toContain('summary');

        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        await flushPromises();

        expect(input.vm.captureInputHistorySnapshot().text).toBe(`${before}${after}`);
        expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');
        editor.commands.undo();
        expect(input.vm.captureInputHistorySnapshot().text).toBe(draft);
        expect(input.vm.captureInputHistorySnapshot().skills ?? []).toEqual([]);
    });

    it.each(['keyboard', 'pointer'] as const)(
        'user immediately undoes a completion accepted by %s and restores the typed query',
        async (method) => {
            installSkillCommands([skillFile('summary'), skillFile('summary-extra')]);
            await open();
            vi.spyOn(Date, 'now').mockReturnValue(Date.now());
            const editor = wrapper.getComponent(EditorContent).props('editor')!;
            input.vm.insertTextAtCursor('Before ');
            input.vm.insertTextAtCursor(`${prefix}sum`);
            await flushPromises();
            if (method === 'keyboard') {
                await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
                await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
            } else {
                await wrapper.get('[role="option"]').trigger('mousedown');
                await wrapper.get('[role="option"]').trigger('click');
            }
            await flushPromises();
            expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');

            editor.commands.undo();
            expect(input.vm.captureInputHistorySnapshot().text).toBe(`Before ${prefix}sum`);
            expect(input.vm.captureInputHistorySnapshot().skills ?? []).toEqual([]);
            editor.commands.redo();
            expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');

            input.vm.insertTextAtCursor(' afterwards');
            editor.commands.undo();
            expect(input.vm.captureInputHistorySnapshot().text).toBe('Before  ');
            expect(input.vm.captureInputHistorySnapshot().skills).toHaveLength(1);
        }
    );

    it('user clicks a retained row during refresh and keeps the draft until availability is known', async () => {
        installSkillCommands([skillFile('summary'), skillFile('summary-extra')]);
        await open();
        input.vm.insertTextAtCursor(`${prefix}sum`);
        await flushPromises();
        const editor = wrapper.get<HTMLElement>('.ProseMirror');
        await editor.trigger('keydown', { key: 'ArrowDown' });
        editor.element.blur();
        let finishDiscovery!: (files: ReturnType<typeof skillFile>[]) => void;
        mockTauriCommand(
            'agent_skills_discover_user_files',
            () => new Promise((resolve) => (finishDiscovery = resolve))
        );
        editor.element.focus();
        await flushPromises();
        expect(pickerShortcutKeys()).toEqual(['↑', '↓', 'Esc']);
        expect(wrapper.get('[data-inline-completion]').attributes('data-inline-completion')).toBe(
            'mary'
        );
        const row = wrapper.get('[role="option"]');
        await row.trigger('mousedown');
        await row.trigger('click');
        expect(input.vm.captureInputHistorySnapshot().skills ?? []).toEqual([]);
        expect(input.vm.captureInputHistorySnapshot().text).toBe(`${prefix}sum`);
        finishDiscovery([]);
        await flushPromises();
        expect(wrapper.find('[role="option"]').exists()).toBe(false);
        expect(wrapper.find('[data-skill-tag]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
        expect(lastSkillInputActiveChange()).toEqual([true]);
    });

    it('user given a visible completion when window focus returns then keeps the same rows and hint throughout validation', async () => {
        await open();
        input.vm.insertTextAtCursor(`${prefix}sum`);
        await flushPromises();
        const editor = wrapper.get<HTMLElement>('.ProseMirror');
        const panel = wrapper.get('[data-testid="skill-picker-panel"]').element;
        const row = wrapper.get<HTMLButtonElement>('[role="option"]');
        const hint = wrapper.get('[data-inline-completion]').element;
        const before = input.vm.captureInputHistorySnapshot();
        editor.element.blur();
        let finishDiscovery!: (files: ReturnType<typeof skillFile>[]) => void;
        mockTauriCommand(
            'agent_skills_discover_user_files',
            () => new Promise((resolve) => (finishDiscovery = resolve))
        );
        editor.element.focus();
        await flushPromises();

        expect(wrapper.get('[data-testid="skill-picker-panel"]').element).toBe(panel);
        expect(wrapper.get('[data-inline-completion]').element).toBe(hint);
        expect(row.element.disabled).toBe(false);
        expect(row.attributes('aria-disabled')).toBe('true');
        await editor.trigger('keydown', { key: 'Tab' });
        expect(input.vm.captureInputHistorySnapshot()).toEqual(before);

        finishDiscovery([skillFile()]);
        await flushPromises();
        expect(wrapper.get('[data-inline-completion]').element).toBe(hint);
        expect(row.attributes('aria-disabled')).toBeUndefined();
        await editor.trigger('keydown', { key: 'Tab' });
        expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');
    });

    it('user opens neutral suggestions then activates the first row with ArrowDown', async () => {
        installSkillCommands([skillFile('summary'), skillFile('review')]);
        await open();
        input.vm.insertTextAtCursor(prefix);
        await flushPromises();
        const editor = wrapper.get('.ProseMirror');
        const options = wrapper.findAll('[role="option"]');
        expect(options.every((option) => option.attributes('aria-selected') === 'false')).toBe(
            true
        );
        expect(editor.attributes('aria-activedescendant')).toBeUndefined();
        expect(pickerShortcutKeys()).toEqual(['↑', '↓', 'Esc']);
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);

        await editor.trigger('keydown', { key: 'ArrowDown' });
        expect(options[0]!.attributes('aria-selected')).toBe('true');
        expect(editor.attributes('aria-activedescendant')).toBe(options[0]!.attributes('id'));
        expect(pickerShortcutKeys()).toEqual(['↑', '↓', 'Enter', 'Tab', 'Esc']);
        expect(wrapper.get('[data-inline-completion]').attributes('data-inline-completion')).toBe(
            'review'
        );
        await editor.trigger('keydown', { key: 'Tab' });
        await flushPromises();
        expect(wrapper.get('[data-skill-tag]').text()).toBe('review');
    });

    it('user given a keyboard-selected skill when scrolling rows under the pointer then retains that target and viewport position', async () => {
        installSkillCommands([skillFile('summary'), skillFile('review')]);
        await open();
        input.vm.insertTextAtCursor(prefix);
        await flushPromises();
        const option = wrapper
            .findAll('[role="option"]')
            .find((row) => row.text().startsWith('summary'))!;
        const editor = wrapper.get('.ProseMirror');
        await editor.trigger('keydown', { key: 'ArrowDown' });
        const activeId = editor.attributes('aria-activedescendant');
        const viewport = wrapper.get<HTMLElement>('[role="listbox"]').element;
        viewport.scrollTop = 128;
        await option.trigger('mouseenter');
        await wrapper.get('[role="listbox"]').trigger('scroll');
        expect(option.attributes('aria-selected')).toBe('false');
        expect(editor.attributes('aria-activedescendant')).toBe(activeId);
        expect(viewport.scrollTop).toBe(128);
        expect(document.activeElement).toBe(editor.element);
        expect(pickerShortcutKeys()).toEqual(['↑', '↓', 'Enter', 'Tab', 'Esc']);
        expect(wrapper.get('[data-inline-completion]').attributes('data-inline-completion')).toBe(
            'review'
        );
        await editor.trigger('keydown', { key: 'Tab' });
        await flushPromises();
        expect(wrapper.get('[data-skill-tag]').text()).toBe('review');
    });

    it('user given a restored draft when selecting a skill and pressing Backspace then removes only that skill', async () => {
        await open();
        input.vm.restoreInputHistorySnapshot({
            text: 'Summarize the notes',
            attachments: [],
            skills: [{ name: 'summary', path: skillFile().path }],
        });
        await flushPromises();
        expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');
        const captured = input.vm.captureInputHistorySnapshot();
        expect(captured.text).toBe('Summarize the notes');
        input.vm.restoreInputHistorySnapshot({ text: '', attachments: [] });
        input.vm.restoreInputHistorySnapshot(captured);
        await flushPromises();
        expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');
        await wrapper.get('[data-skill-tag]').trigger('click');
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Backspace' });
        await flushPromises();
        expect(input.vm.captureInputHistorySnapshot().skills ?? []).toEqual([]);
        expect(input.vm.captureInputHistorySnapshot().text).toBe('Summarize the notes');
    });

    it('user keeps a failed skill query and sees suggestions after discovery recovers', async () => {
        mockTauriCommand('agent_skills_discover_user_files', () => {
            throw new Error('Disk unavailable');
        });
        await open();
        input.vm.insertTextAtCursor(`${prefix}sum`);
        await flushPromises();
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
        expect(input.vm.captureInputHistorySnapshot().text).toBe(`${prefix}sum`);
        expect(lastSkillInputActiveChange()).toEqual([true]);
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Escape' });
        installSkillCommands();
        input.vm.insertTextAtCursor('m');
        await flushPromises();
        expect(wrapper.get('[data-inline-completion]').attributes('data-inline-completion')).toBe(
            'ary'
        );
    });

    it('user filters matching skills then closes the launcher panel on no matches and reopens it for a matching query', async () => {
        let finishDiscovery!: (files: ReturnType<typeof skillFile>[]) => void;
        mockTauriCommand(
            'agent_skills_discover_user_files',
            () => new Promise((resolve) => (finishDiscovery = resolve))
        );
        await open();
        input.vm.insertTextAtCursor(prefix);
        await flushPromises();
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);

        finishDiscovery(Array.from({ length: 8 }, (_, index) => skillFile(`skill-${index}`)));
        await flushPromises();
        expect(wrapper.findAll('[role="option"]')).toHaveLength(8);

        input.vm.insertTextAtCursor('skill-0');
        await flushPromises();
        expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);

        input.vm.insertTextAtCursor('-missing');
        await flushPromises();
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
        expect(lastSkillInputActiveChange()).toEqual([true]);

        input.vm.restoreInputHistorySnapshot({ text: `${prefix}skill-0`, attachments: [] });
        await flushPromises();
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(true);
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        expect(wrapper.get('[data-skill-tag]').text()).toBe('skill-0');
    });

    it('user keeps skill intent while loading finishes without any matching results', async () => {
        let finishDiscovery!: (files: ReturnType<typeof skillFile>[]) => void;
        mockTauriCommand(
            'agent_skills_discover_user_files',
            () => new Promise((resolve) => (finishDiscovery = resolve))
        );
        await open();
        input.vm.insertTextAtCursor(`${prefix}missing-skill`);
        await flushPromises();
        const editor = wrapper.get('.ProseMirror');
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
        expect(editor.attributes('aria-expanded')).toBe('false');
        expect(editor.attributes('aria-controls')).toBeUndefined();
        expect(lastSkillInputActiveChange()).toEqual([true]);

        finishDiscovery([]);
        await flushPromises();
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
        expect(editor.attributes('aria-expanded')).toBe('false');
        expect(editor.attributes('aria-controls')).toBeUndefined();
        expect(wrapper.find('[role="option"]').exists()).toBe(false);
        await editor.trigger('keydown', { key: 'Enter' });
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
        expect(input.vm.captureInputHistorySnapshot().text).toBe(`${prefix}missing-skill`);
        expect(lastSkillInputActiveChange()).toEqual([true]);
    });

    it('user searches without skill matches in a conversation then retains its compact empty message', async () => {
        await open();
        await wrapper.setProps({ compact: true });
        input.vm.insertTextAtCursor(`${prefix}missing-skill`);
        await flushPromises();
        expect(wrapper.get('[role="status"]').text()).toBe('No matching skills found');
        expect(wrapper.get('.ProseMirror').attributes('aria-expanded')).toBe('true');
        expect(lastSkillInputActiveChange()).toEqual([true]);
        await wrapper.setProps({ compact: false });
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
        expect(wrapper.get('.ProseMirror').attributes('aria-expanded')).toBe('false');
        await wrapper.setProps({ compact: true });
        expect(wrapper.get('[role="status"]').text()).toBe('No matching skills found');
        expect(input.vm.captureInputHistorySnapshot().text).toBe(`${prefix}missing-skill`);
    });

    it('user refocuses an unmatched launcher skill query then keeps it collapsed while discovery is pending', async () => {
        await open();
        input.vm.insertTextAtCursor(`${prefix}missing-skill`);
        await flushPromises();
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
        const editor = wrapper.get<HTMLElement>('.ProseMirror');
        editor.element.blur();
        let finishDiscovery!: (files: ReturnType<typeof skillFile>[]) => void;
        mockTauriCommand(
            'agent_skills_discover_user_files',
            () => new Promise((resolve) => (finishDiscovery = resolve))
        );
        editor.element.focus();
        await flushPromises();
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
        expect(editor.attributes('aria-expanded')).toBe('false');
        finishDiscovery([skillFile('missing-skill')]);
        await flushPromises();
        expect(wrapper.get('[role="option"]').text()).toContain('missing-skill');
        expect(editor.attributes('aria-expanded')).toBe('true');
        expect(input.vm.captureInputHistorySnapshot().text).toBe(`${prefix}missing-skill`);
    });

    it('user leaves a loading prefix query and sees its inline completion arrive without restoring focus or changing the draft', async () => {
        let finishDiscovery!: (files: ReturnType<typeof skillFile>[]) => void;
        mockTauriCommand(
            'agent_skills_discover_user_files',
            () => new Promise((resolve) => (finishDiscovery = resolve))
        );
        await open();
        input.vm.insertTextAtCursor(`${prefix}sum`);
        await flushPromises();
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);

        const editor = wrapper.get<HTMLElement>('.ProseMirror');
        editor.element.blur();
        await flushPromises();
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
        finishDiscovery([skillFile()]);
        await flushPromises();
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(true);
        expect(wrapper.get('[data-inline-completion]').attributes('data-inline-completion')).toBe(
            'mary'
        );
        expect(input.vm.captureInputHistorySnapshot().text).toBe(`${prefix}sum`);
        expect(document.activeElement).not.toBe(editor.element);

        installSkillCommands();
        editor.element.focus();
        await flushPromises();
        expect(wrapper.get('[data-inline-completion]').attributes('data-inline-completion')).toBe(
            'mary'
        );
        expect(document.activeElement).toBe(editor.element);
    });

    it('user clicks outside the input and returns to accept the same highlighted skill', async () => {
        installSkillCommands([skillFile('summary'), skillFile('review')]);
        await open();
        input.vm.insertTextAtCursor(prefix);
        await flushPromises();
        const editor = wrapper.get<HTMLElement>('.ProseMirror');
        await editor.trigger('keydown', { key: 'ArrowDown' });
        await editor.trigger('keydown', { key: 'ArrowDown' });
        const selectedId = editor.attributes('aria-activedescendant');
        expect(wrapper.get('[aria-selected="true"]').text()).toContain('summary');

        await wrapper.trigger('mousedown');
        editor.element.blur();
        await flushPromises();
        expect(wrapper.get('[aria-selected="true"]').text()).toContain('summary');
        expect(editor.attributes('aria-activedescendant')).toBe(selectedId);

        editor.element.focus();
        await flushPromises();
        expect(editor.attributes('aria-activedescendant')).toBe(selectedId);
        await editor.trigger('keydown', { key: 'Tab' });
        await flushPromises();
        expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');
    });

    it('user returns after a skill is disabled and sees current candidates without the disabled choice', async () => {
        installSkillCommands([skillFile('summary'), skillFile('review')]);
        await open();
        input.vm.insertTextAtCursor(prefix);
        await flushPromises();
        const editor = wrapper.get<HTMLElement>('.ProseMirror');
        await editor.trigger('keydown', { key: 'ArrowDown' });
        await editor.trigger('keydown', { key: 'ArrowDown' });
        expect(wrapper.get('[aria-selected="true"]').text()).toContain('summary');
        editor.element.blur();
        await flushPromises();
        expect(wrapper.findAll('[role="option"]')).toHaveLength(2);

        installSkillCommands([skillFile('review')]);
        editor.element.focus();
        await flushPromises();
        expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
        expect(wrapper.get('[role="option"]').text()).toContain('review');
        expect(editor.attributes('aria-activedescendant')).toBeUndefined();
        expect(pickerShortcutKeys()).toEqual(['↑', '↓', 'Esc']);
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
        await editor.trigger('keydown', { key: 'Tab' });
        await flushPromises();
        expect(wrapper.find('[data-skill-tag]').exists()).toBe(false);
        expect(input.vm.captureInputHistorySnapshot().text).toBe(prefix);
        await editor.trigger('keydown', { key: 'ArrowDown' });
        await editor.trigger('keydown', { key: 'Tab' });
        await flushPromises();
        expect(wrapper.get('[data-skill-tag]').text()).toBe('review');
    });

    it('user clicks a retained suggestion after blur and replaces only its trigger', async () => {
        installSkillCommands([skillFile('summary'), skillFile('summary-extra')]);
        await open();
        input.vm.insertTextAtCursor(`Please use ${prefix}sum`);
        await flushPromises();
        wrapper.get<HTMLElement>('.ProseMirror').element.blur();
        await flushPromises();
        const option = wrapper.get('[role="option"]');
        await option.trigger('mousedown');
        await option.trigger('click');
        await flushPromises();

        expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');
        expect(input.vm.captureInputHistorySnapshot().text).toBe('Please use  ');
        await vi.waitFor(() => {
            expect(document.activeElement).toBe(wrapper.get('.ProseMirror').element);
        });
    });

    it('user returns while skills refresh and keeps the current results until explicitly dismissing them', async () => {
        installSkillCommands([skillFile('summary'), skillFile('summary-extra')]);
        await open();
        input.vm.insertTextAtCursor(`${prefix}sum`);
        await flushPromises();
        const editor = wrapper.get<HTMLElement>('.ProseMirror');
        await editor.trigger('keydown', { key: 'ArrowDown' });
        const selectedId = editor.attributes('aria-activedescendant');
        editor.element.blur();
        let finishDiscovery!: (files: ReturnType<typeof skillFile>[]) => void;
        mockTauriCommand(
            'agent_skills_discover_user_files',
            () => new Promise((resolve) => (finishDiscovery = resolve))
        );

        editor.element.focus();
        await flushPromises();
        expect(wrapper.get('[role="option"]').text()).toContain('summary');
        expect(editor.attributes('aria-activedescendant')).toBe(selectedId);
        await editor.trigger('keydown', { key: 'Escape' });
        finishDiscovery([skillFile()]);
        await flushPromises();
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
        expect(input.vm.captureInputHistorySnapshot().text).toBe(`${prefix}sum`);
    });

    it('user clicks a skill in the result panel and inserts it without opening its file', async () => {
        installSkillCommands([skillFile('summary'), skillFile('summary-extra')]);
        await open();
        input.vm.insertTextAtCursor(`Please use ${prefix}sum`);
        await flushPromises();
        const option = wrapper.get('[data-testid="skill-picker-panel"] [role="option"]');
        await option.trigger('mousedown');
        await option.trigger('click');
        await flushPromises();

        expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');
        expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
        expect(document.activeElement).toBe(wrapper.get('.ProseMirror').element);
        input.vm.insertTextAtCursor('today');
        expect(input.vm.captureInputHistorySnapshot().text).toBe('Please use  today');
        expect(getTauriInvokeCalls('plugin:opener|open_path')).toEqual([]);
        expect(getTauriInvokeCalls('quick_search_search_shortcuts')).toEqual([]);
    });

    it('user searches the end of a long description and reads its complete text in the result', async () => {
        const file = skillFile();
        const description = `A useful skill. ${'Detailed guidance. '.repeat(20)}searchableending`;
        installSkillCommands([
            { ...file, frontmatter: `---\nname: summary\ndescription: ${description}\n---\n` },
        ]);
        await open();
        input.vm.insertTextAtCursor(`${prefix}searchableending`);
        await flushPromises();
        const option = wrapper.get('[data-testid="skill-picker-panel"] [role="option"]');
        expect(option.text()).toContain('A useful skill.');
        expect(option.text()).toContain(description);
    });
});

describe('given ordinary skill results span more than one batch', () => {
    beforeEach(() => {
        installSkillCommands(Array.from({ length: 14 }, (_, index) => skillFile(`skill-${index}`)));
    });

    it('user returns upward to the first batch and sees the panel shrink without leaving the editor', async () => {
        await open();
        await wrapper.setProps({ pickerMaxHeight: 600 });
        input.vm.insertTextAtCursor('/');
        await flushPromises();
        const editor = wrapper.get('.ProseMirror');
        const viewport = wrapper.get<HTMLElement>('[role="listbox"]').element;
        const initialHeight = viewport.style.height;

        for (let index = 0; index < 8; index++) {
            await editor.trigger('keydown', { key: 'ArrowDown' });
        }
        expect(parseFloat(viewport.style.height)).toBeGreaterThan(parseFloat(initialHeight));
        await editor.trigger('keydown', { key: 'ArrowUp' });
        expect(parseFloat(viewport.style.height)).toBeGreaterThan(parseFloat(initialHeight));
        await editor.trigger('keydown', { key: 'ArrowUp' });

        expect(viewport.style.height).toBe(initialHeight);
        expect(wrapper.findAll('[role="option"]')[5]!.attributes('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(editor.element);
        await editor.trigger('keydown', { key: 'ArrowDown' });
        expect(parseFloat(viewport.style.height)).toBeGreaterThan(parseFloat(initialHeight));
    });

    it('user refreshes wheel-expanded results and keeps their height until navigating upward', async () => {
        await open();
        await wrapper.setProps({ pickerMaxHeight: 600 });
        input.vm.insertTextAtCursor('/');
        await flushPromises();
        const editor = wrapper.get<HTMLElement>('.ProseMirror');
        const viewport = wrapper.get<HTMLElement>('[role="listbox"]');
        const initialHeight = viewport.element.style.height;
        await viewport.trigger('wheel', { deltaY: 120 });
        const expandedHeight = viewport.element.style.height;
        expect(parseFloat(expandedHeight)).toBeGreaterThan(parseFloat(initialHeight));

        editor.element.blur();
        editor.element.focus();
        await flushPromises();
        expect(viewport.element.style.height).toBe(expandedHeight);
        await editor.trigger('keydown', { key: 'ArrowDown' });
        expect(viewport.element.style.height).toBe(expandedHeight);
        await editor.trigger('keydown', { key: 'ArrowUp' });
        expect(viewport.element.style.height).toBe(initialHeight);
        expect(editor.attributes('aria-activedescendant')).toBeUndefined();
    });

    it('user navigates across the same batches in a conversation without changing the floating panel height', async () => {
        await open();
        await wrapper.setProps({ compact: true, pickerMaxHeight: 600 });
        input.vm.insertTextAtCursor('/');
        await flushPromises();
        const editor = wrapper.get('.ProseMirror');
        const viewport = wrapper.get<HTMLElement>('[role="listbox"]');
        const initialHeight = viewport.element.style.height;
        await viewport.trigger('wheel', { deltaY: 120 });
        for (let index = 0; index < 8; index++) {
            await editor.trigger('keydown', { key: 'ArrowDown' });
            expect(viewport.element.style.height).toBe(initialHeight);
        }
        for (let index = 0; index < 8; index++) {
            await editor.trigger('keydown', { key: 'ArrowUp' });
            expect(viewport.element.style.height).toBe(initialHeight);
        }
        expect(document.activeElement).toBe(editor.element);
    });
});

describe('given a skill result has a long multiline summary', () => {
    it.each(['description', 'short description'])(
        'user reads the complete %s with collapsed whitespace',
        (source) => {
            const summary = `  Read the full guidance.\n${'Detailed   instructions.\t'.repeat(12)}Final step.\n`;
            const displayedSummary = `Read the full guidance. ${'Detailed instructions. '.repeat(12)}Final step.`;
            const { name, path, directory } = skillFile();
            wrapper = mount(SkillPickerPanel, {
                props: {
                    picker: {
                        listId: 'skill-summary',
                        query: '',
                        loading: false,
                        error: false,
                        candidates: [
                            {
                                name,
                                path,
                                directory,
                                description: source === 'description' ? summary : 'Fallback text',
                                shortDescription: source === 'short description' ? summary : null,
                            },
                        ],
                        highlightedIndex: -1,
                    },
                },
            });

            const option = wrapper.get('[role="option"]');
            expect(option.text()).toContain(displayedSummary);
            expect(option.text()).not.toContain('Fallback text');
        }
    );
});

describe('given a conversation uses the compact skill picker', () => {
    it.each(['Enter', 'Tab'])(
        'user opens skills, navigates and keeps typing before accepting the first current match with %s without leaving the editor',
        async (key) => {
            installSkillCommands([skillFile('beta'), skillFile('alpine'), skillFile('alpha')]);
            await open();
            await wrapper.setProps({ compact: true });
            input.vm.insertTextAtCursor('/');
            await flushPromises();
            const editor = wrapper.get('.ProseMirror');
            const selectedName = () =>
                wrapper
                    .get('[role="option"][aria-selected="true"] [data-slot="result-item-label"]')
                    .text();

            expect(selectedName()).toBe('alpha');
            expect(document.activeElement).toBe(editor.element);
            await editor.trigger('keydown', { key: 'ArrowDown' });
            expect(selectedName()).toBe('alpine');
            await editor.trigger('keydown', { key: 'ArrowUp' });
            await editor.trigger('keydown', { key: 'ArrowUp' });
            expect(selectedName()).toBe('alpha');
            await editor.trigger('keydown', { key: 'ArrowDown' });
            input.vm.insertTextAtCursor('al');
            await flushPromises();

            expect(wrapper.findAll('[role="option"]')).toHaveLength(2);
            expect(selectedName()).toBe('alpha');
            expect(editor.attributes('aria-activedescendant')).toBe(
                wrapper.get('[role="option"][aria-selected="true"]').attributes('id')
            );
            expect(input.vm.captureInputHistorySnapshot().text).toBe('/al');
            expect(document.activeElement).toBe(editor.element);
            await editor.trigger('keydown', { key });
            await flushPromises();

            expect(
                input.vm.captureInputHistorySnapshot().skills?.map((skill) => skill.name)
            ).toEqual(['alpha']);
            expect(document.activeElement).toBe(editor.element);
            input.vm.insertTextAtCursor('continue');
            expect(input.vm.captureInputHistorySnapshot().text).toBe(' continue');
        }
    );

    it('user opens skills and sees names with source tags without leading icons', async () => {
        await open();
        await wrapper.setProps({ compact: true });
        input.vm.insertTextAtCursor('/');
        await flushPromises();
        const option = wrapper.get('[role="option"]');
        expect(option.get('[data-slot="result-item-label"]').text()).toBe('summary');
        expect(option.get('[data-slot="skill-scope"]').text()).toBe('Global');
        expect(option.find('[data-slot="result-item-icon"]').exists()).toBe(false);
    });
});

describe('given the main input contains a URL or file path', () => {
    it.each(['/', '\\'])(
        'user moves the caret inside a path with %s and keeps Tab from inserting a skill',
        async (separator) => {
            await open();
            const path = `/sum${separator}report.md`;
            input.vm.insertTextAtCursor(path);
            const editor = wrapper.getComponent(EditorContent).props('editor')!;
            editor.commands.setTextSelection(5);
            await flushPromises();

            expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
            expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
            expect(lastSkillInputActiveChange()).toEqual([false]);
            await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
            expect(input.vm.captureInputHistorySnapshot().text).toBe(path);
            expect(input.vm.captureInputHistorySnapshot().skills ?? []).toEqual([]);
            expect(getTauriInvokeCalls('agent_skills_discover_user_files')).toEqual([]);
        }
    );

    it.each(['https://example.com', 'C:/Users', 'foo/bar', '/usr/local'])(
        'user keeps %s as ordinary search text without discovering skills',
        async (text) => {
            await open();
            input.vm.insertTextAtCursor(text);
            await flushPromises();

            expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
            expect(lastSkillInputActiveChange()).toEqual([false]);
            expect(input.vm.captureInputHistorySnapshot().text).toBe(text);
            expect(getTauriInvokeCalls('agent_skills_discover_user_files')).toEqual([]);
        }
    );

    it.each(['/', '\\'])(
        'user regains file search when continuing a dismissed slash query into a path with %s',
        async (separator) => {
            await open();
            input.vm.insertTextAtCursor('/usr');
            await flushPromises();
            expect(lastSkillInputActiveChange()).toEqual([true]);
            expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);

            await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Escape' });
            await flushPromises();
            expect(lastSkillInputActiveChange()).toEqual([true]);

            input.vm.insertTextAtCursor(separator);
            await flushPromises();
            expect(lastSkillInputActiveChange()).toEqual([false]);
            expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);

            input.vm.insertTextAtCursor('local notes');
            await flushPromises();
            expect(lastSkillInputActiveChange()).toEqual([false]);
            expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(false);
            expect(input.vm.captureInputHistorySnapshot().text).toBe(`/usr${separator}local notes`);
        }
    );
});
