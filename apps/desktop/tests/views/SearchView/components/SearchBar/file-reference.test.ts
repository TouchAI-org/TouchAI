import { installSkillCommands } from '@tests/utils/skills';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { EditorContent } from '@tiptap/vue-3';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, ref, watch } from 'vue';

import { setLocale } from '@/i18n';
import type { InputHistorySnapshot } from '@/types/session';
import QuickSearchPanel from '@/views/SearchView/components/QuickSearchPanel/index.vue';
import SearchBar from '@/views/SearchView/components/SearchBar/index.vue';
import type { FilePickerContext } from '@/views/SearchView/components/SearchBar/types';
import { useSearchAttachments } from '@/views/SearchView/composables/useSearchInput';

const files = [
    { name: 'README.md', path: 'D:/docs/README.md', source: 'file' },
    { name: 'README-contributing.md', path: 'D:/docs/README-contributing.md', source: 'file' },
];
let wrapper: VueWrapper;
const rangeDescriptors = ['getClientRects', 'getBoundingClientRect'].map((name) => ({
    name,
    descriptor: Object.getOwnPropertyDescriptor(Range.prototype, name),
}));

const FileSearchInput = defineComponent({
    components: { SearchBar, QuickSearchPanel },
    props: {
        compact: { type: Boolean, default: false },
        unmountClosed: { type: Boolean, default: false },
    },
    setup() {
        const query = ref('read');
        const open = ref(true);
        const panel = ref<InstanceType<typeof QuickSearchPanel>>();
        const searchInput = ref<InstanceType<typeof SearchBar>>();
        const fileQuery = ref<string | null>(null);
        const filePickerContext = ref<FilePickerContext | null>(null);
        watch(fileQuery, (value) => {
            open.value = value !== null;
        });
        const {
            attachments,
            createAttachmentFromSearchResult,
            handleModelChange,
            removeAttachment,
            restoreAttachment,
        } = useSearchAttachments();
        handleModelChange({ supportsImages: true, supportsFiles: true });
        const completeFile = computed(() => {
            if (!open.value || (attachments.value.length && fileQuery.value === null))
                return undefined;
            return (index?: number) => {
                const item = panel.value?.getReferenceCandidate(
                    index,
                    fileQuery.value ?? query.value
                );
                if (!item) return null;
                const attachment = createAttachmentFromSearchResult(item);
                attachments.value.push(attachment);
                open.value = false;
                return attachment;
            };
        });
        function recall(snapshot: InputHistorySnapshot) {
            attachments.value = snapshot.attachments;
            searchInput.value?.restoreInputHistorySnapshot(snapshot);
        }
        return {
            query,
            open,
            panel,
            searchInput,
            attachments,
            completeFile,
            fileQuery,
            filePickerContext,
            removeAttachment,
            restoreAttachment,
            recall,
        };
    },
    template: `<div>
        <SearchBar ref="searchInput" v-model:query-text="query" :attachments="attachments"
            :complete-file="completeFile" :start-dragging="async () => {}"
            :file-picker-context="filePickerContext"
            :move-file-selection="direction => panel?.moveSelection(direction)"
            @file-autocomplete-query-change="fileQuery = $event"
            @attachment-remove-request="removeAttachment"
            @attachment-restore-request="restoreAttachment" />
        <QuickSearchPanel v-if="!unmountClosed || open" ref="panel" v-model:open="open" :search-query="fileQuery ?? query"
            :reference-mode="fileQuery !== null" :compact="compact"
            @reference-state-change="filePickerContext = $event"
            @reference="index => searchInput?.completeFileReference(index)" />
    </div>`,
});

beforeEach(() => {
    setLocale('en-US');
    installSkillCommands();
    mockTauriCommand('database_query', { rows: [], rowsAffected: 0, lastInsertId: null });
    mockTauriCommand('database_operation', []);
    mockTauriCommand('quick_search_prepare_index', undefined);
    mockTauriCommand('quick_search_get_status', { db_loaded: true, index_warmed: true });
    mockTauriCommand('quick_search_get_shortcut_icons', {});
    mockTauriCommand('quick_search_get_image_thumbnails', {});
    mockTauriCommand('quick_search_file_reference_suggestions', []);
    mockTauriCommand('quick_search_search_shortcuts', {
        shortcuts: [],
        files,
        total_files: files.length,
        total_results: files.length,
        next_offset: files.length,
    });
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

async function openFiles(compact = false, unmountClosed = false) {
    wrapper = mount(FileSearchInput, {
        attachTo: document.body,
        props: { compact, unmountClosed },
        global: { plugins: [createPinia()] },
    });
    const input = wrapper.getComponent(SearchBar);
    const panel = wrapper.getComponent(QuickSearchPanel);
    await flushPromises();
    const editor = wrapper.getComponent(EditorContent).props('editor')!;
    panel.vm.open();
    await flushPromises();
    panel.vm.toggleViewMode();
    editor.commands.focus('end');
    await new Promise(requestAnimationFrame);
    return { input, panel, editor };
}

describe('given file completion overlays a conversation', () => {
    it('user activates a result with selected text and attached file identities without sending search keywords as input', async () => {
        const { input, editor } = await openFiles();
        expect(input.vm.captureSearchActivationInput()).toEqual({ files: [] });
        editor.commands.setTextSelection({ from: 1, to: 5 });
        expect(input.vm.captureSearchActivationInput()).toEqual({ text: 'read', files: [] });
    });
    it.each(['Enter', 'Tab'])(
        'user opens files, navigates and refines the query before inserting the first current result with %s while keeping editor focus',
        async (key) => {
            const { input, editor } = await openFiles(true);
            editor.commands.setTextSelection({ from: 1, to: 5 });
            input.vm.insertTextAtCursor('Read @read');
            await vi.waitFor(() => expect(wrapper.findAll('[role="option"]')).toHaveLength(2));
            const editorElement = wrapper.get('.ProseMirror');
            const selectedName = () =>
                wrapper
                    .get('[role="option"][aria-selected="true"] [data-slot="result-item-label"]')
                    .text();
            expect(selectedName()).toBe('README.md');
            expect(document.activeElement).toBe(editor.view.dom);
            await editorElement.trigger('keydown', { key: 'ArrowDown' });
            expect(selectedName()).toBe('README-contributing.md');
            await editorElement.trigger('keydown', { key: 'ArrowUp' });
            await editorElement.trigger('keydown', { key: 'ArrowUp' });
            expect(selectedName()).toBe('README.md');
            await editorElement.trigger('keydown', { key: 'ArrowDown' });
            input.vm.insertTextAtCursor('me');
            await vi.waitFor(() => expect(selectedName()).toBe('README.md'));
            expect(editorElement.attributes('aria-activedescendant')).toBe(
                wrapper.get('[role="option"][aria-selected="true"]').attributes('id')
            );
            expect(input.vm.captureInputHistorySnapshot().text).toBe('Read @readme');
            expect(document.activeElement).toBe(editor.view.dom);
            await editorElement.trigger('keydown', { key });
            await flushPromises();
            expect(
                input.vm.captureInputHistorySnapshot().attachments.map((file) => file.name)
            ).toEqual(['README.md']);
            expect(document.activeElement).toBe(editor.view.dom);
            expect(getTauriInvokeCalls('plugin:opener|open_path')).toEqual([]);
        }
    );
});

describe('given file results beside the main input', () => {
    it('user clears a bare file query and sees only the empty-input placeholder after its picker unmounts', async () => {
        mockTauriCommand('quick_search_file_reference_suggestions', files);
        const { input, editor } = await openFiles(true, true);
        editor.commands.setTextSelection({ from: 1, to: 5 });
        input.vm.insertTextAtCursor('@');
        await vi.waitFor(() => {
            expect(
                wrapper.get('[data-inline-completion]').attributes('data-inline-completion')
            ).toBe('README.md');
        });
        editor.commands.clearContent();
        await flushPromises();
        expect(wrapper.findComponent(QuickSearchPanel).exists()).toBe(false);
        expect(input.props('filePickerContext')).toBeNull();
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
        expect(wrapper.get('.ProseMirror p').attributes('data-placeholder')).toBe(
            'Write your request...'
        );
        expect(input.vm.captureInputHistorySnapshot().text).toBe('');
    });

    it('user loses file-reference availability while a result is retained and no longer sees or accepts its completion', async () => {
        const completeFile = vi.fn(() => null);
        wrapper = mount(SearchBar, {
            attachTo: document.body,
            props: {
                queryText: 'read',
                completeFile,
                filePickerContext: {
                    listId: 'retained-files',
                    completion: { index: 0, text: 'ME.md', query: 'read', implicit: false },
                },
                startDragging: async () => {},
            },
            global: { plugins: [createPinia()] },
        });
        await flushPromises();
        const editor = wrapper.getComponent(EditorContent).props('editor')!;
        editor.commands.focus('end');
        await new Promise(requestAnimationFrame);
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(true);
        await wrapper.setProps({ completeFile: undefined });
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        expect(completeFile).not.toHaveBeenCalled();
        expect(editor.getText()).toBe('read');
    });

    it.each(['read', 'Please read @read'])(
        'user given %j when selecting a file then previews its suffix without adding it to the draft',
        async (draft) => {
            const { input, panel, editor } = await openFiles();
            if (draft !== 'read') {
                editor.commands.setTextSelection({ from: 1, to: 5 });
                input.vm.insertTextAtCursor(draft);
                await vi.waitFor(() => expect(wrapper.findAll('[role="option"]')).toHaveLength(2));
            }
            expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
            panel.vm.moveSelection('down');
            await flushPromises();
            expect(
                wrapper.get('[data-inline-completion]').attributes('data-inline-completion')
            ).toBe('ME.md');
            expect(input.vm.captureInputHistorySnapshot().text).toBe(draft);
            expect(JSON.stringify(input.vm.captureInputHistorySnapshot().editorDoc)).not.toContain(
                'ME.md'
            );
            panel.vm.moveSelection('down');
            await flushPromises();
            expect(
                wrapper.get('[data-inline-completion]').attributes('data-inline-completion')
            ).toBe('ME-contributing.md');
            await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
            expect(input.vm.captureInputHistorySnapshot().attachments[0]?.name).toBe(
                'README-contributing.md'
            );
            expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
        }
    );

    it.each(['read', 'Please read @read'])(
        'user given a single prefix match for %j when pressing Tab then inserts the file shown by the implicit hint',
        async (draft) => {
            mockTauriCommand('quick_search_search_shortcuts', {
                shortcuts: [],
                files: [files[0]],
                total_files: 1,
                total_results: 1,
                next_offset: 1,
            });
            const { input, editor } = await openFiles();
            if (draft !== 'read') {
                editor.commands.setTextSelection({ from: 1, to: 5 });
                input.vm.insertTextAtCursor(draft);
                await flushPromises();
            }
            await vi.waitFor(() => {
                expect(
                    wrapper.get('[data-slot="result-panel-viewport"]').attributes('aria-busy')
                ).toBe('false');
                expect(wrapper.find('[data-inline-completion]').exists()).toBe(true);
            });
            expect(
                wrapper.get('[data-inline-completion]').attributes('data-inline-completion')
            ).toBe('ME.md');
            expect(wrapper.findAll('[data-slot="result-item"]')).toHaveLength(1);
            await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
            expect(input.vm.captureInputHistorySnapshot().attachments[0]?.name).toBe('README.md');
            expect(getTauriInvokeCalls('plugin:opener|open_path')).toEqual([]);
        }
    );

    it('user given a file completion when refocusing or composing then keeps the hint on refocus and hides it during IME', async () => {
        const { panel, editor } = await openFiles();
        panel.vm.moveSelection('down');
        await flushPromises();
        const hint = wrapper.get('[data-inline-completion]').element;
        editor.view.dom.blur();
        editor.view.dom.focus();
        await flushPromises();
        expect(wrapper.get('[data-inline-completion]').element).toBe(hint);
        await wrapper.get('.ProseMirror').trigger('compositionstart');
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
        await wrapper.get('.ProseMirror').trigger('compositionend');
        await flushPromises();
        expect(wrapper.get('[data-inline-completion]').attributes('data-inline-completion')).toBe(
            'ME.md'
        );
    });

    it('user given a selected file when replacing its query then sees no stale suffix and cannot accept the old result', async () => {
        const { input, panel, editor } = await openFiles();
        panel.vm.moveSelection('down');
        await flushPromises();
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(true);
        let finish!: (result: unknown) => void;
        mockTauriCommand(
            'quick_search_search_shortcuts',
            () => new Promise((resolve) => (finish = resolve))
        );
        editor.commands.setTextSelection({ from: 1, to: 5 });
        input.vm.insertTextAtCursor('other');
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        expect(input.vm.captureInputHistorySnapshot().attachments).toEqual([]);
        finish({ shortcuts: [], files: [], total_files: 0, total_results: 0, next_offset: 0 });
        await flushPromises();
    });

    it.each([
        { name: 'README.md', total: 2 },
        { name: 'already.md', total: 1 },
    ])(
        'user given one visible file %j without a unique prefix match when pressing Tab then retains the draft',
        async ({ name, total }) => {
            mockTauriCommand('quick_search_search_shortcuts', {
                shortcuts: [],
                files: [{ ...files[0], name }],
                total_files: total,
                total_results: total,
                next_offset: 1,
            });
            const { input } = await openFiles();
            expect(wrapper.findAll('[data-slot="result-item"]')).toHaveLength(1);
            expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
            await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
            expect(input.vm.captureInputHistorySnapshot().attachments).toEqual([]);
            expect(input.vm.captureInputHistorySnapshot().text).toBe('read');
        }
    );

    it('user given a unique file prefix when moving the caret into the token then sees no implicit hint and cannot accept it', async () => {
        mockTauriCommand('quick_search_search_shortcuts', {
            shortcuts: [],
            files: [files[0]],
            total_files: 1,
            total_results: 1,
            next_offset: 1,
        });
        const { input, editor } = await openFiles();
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(true);
        editor.commands.setTextSelection(3);
        await flushPromises();
        expect(wrapper.find('[data-inline-completion]').exists()).toBe(false);
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        expect(input.vm.captureInputHistorySnapshot().attachments).toEqual([]);
        expect(input.vm.captureInputHistorySnapshot().text).toBe('read');
    });

    it('user given a completed file reference when continuing to type then starts after one automatic space and can undo the reference as one edit', async () => {
        const { input, panel, editor } = await openFiles();
        panel.vm.moveSelection('down');
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        await flushPromises();
        expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\ufffc')).toBe(
            '\ufffc '
        );
        expect(editor.state.selection.$from.nodeBefore?.text).toBe(' ');
        editor.commands.undo();
        await flushPromises();
        expect(input.vm.captureInputHistorySnapshot().text).toBe('read');
        expect(input.vm.captureInputHistorySnapshot().attachments).toEqual([]);
        editor.commands.redo();
        input.vm.insertTextAtCursor('explain');
        expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\ufffc')).toBe(
            '\ufffc explain'
        );
    });

    it.each(['Please compare ', '请分析', 'First line\nPlease read '])(
        'user given existing text %s when typing @ then searches only the filename and keeps surrounding text',
        async (before) => {
            const { input, editor } = await openFiles();
            editor.commands.setTextSelection({ from: 1, to: 5 });
            input.vm.insertTextAtCursor(`${before}@README.md afterwards`);
            editor.commands.setTextSelection(before.length + '@REA'.length + 1);
            await flushPromises();
            await vi.waitFor(() => {
                expect(
                    getTauriInvokeCalls('quick_search_search_shortcuts').some(
                        (call) => (call.payload as { query: string }).query === 'REA'
                    )
                ).toBe(true);
            });
            await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
            await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Enter' });
            await flushPromises();
            expect(wrapper.get('[data-attachment-tag]').text()).toBe('README.md');
            expect(input.vm.captureInputHistorySnapshot().text).toBe(`${before} afterwards`);
            expect(document.activeElement).toBe(editor.view.dom);
            expect(getTauriInvokeCalls('plugin:opener|open_path')).toEqual([]);
        }
    );

    it('user given a bare @ when recent documents exist then opens the file picker and Tab inserts the selected document', async () => {
        const recentDocument = {
            name: 'Recent.md',
            path: 'D:/Docs/Recent.md',
            source: 'file',
        } as const;
        mockTauriCommand('quick_search_file_reference_suggestions', [recentDocument]);
        const { input, editor } = await openFiles(true);
        const generalSearchCount = getTauriInvokeCalls('quick_search_search_shortcuts').length;
        editor.commands.setTextSelection({ from: 1, to: 5 });

        input.vm.insertTextAtCursor('Please read @');

        await vi.waitFor(() => expect(wrapper.findAll('[role="option"]')).toHaveLength(1));
        expect(getTauriInvokeCalls('quick_search_file_reference_suggestions')).toContainEqual(
            expect.objectContaining({
                payload: expect.objectContaining({
                    recentPaths: [],
                    limit: 12,
                }),
            })
        );
        expect(getTauriInvokeCalls('quick_search_search_shortcuts')).toHaveLength(
            generalSearchCount
        );
        expect(wrapper.get('[role="option"]').text()).toContain('Recent.md');
        expect(document.activeElement).toBe(editor.view.dom);

        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        await flushPromises();

        expect(input.vm.captureInputHistorySnapshot().attachments.map((file) => file.name)).toEqual(
            ['Recent.md']
        );
        expect(wrapper.find('[data-testid="quick-search-panel"]').exists()).toBe(false);
        expect(document.activeElement).toBe(editor.view.dom);
        await vi.waitFor(() => {
            expect(
                getTauriInvokeCalls('database_operation').some((call) => {
                    const payload = JSON.stringify(call.payload);
                    return payload.includes('@reference') && payload.includes('Recent.md');
                })
            ).toBe(true);
        });
    });

    it('user given a bare @ without suggestions keeps the launcher closed and can dismiss without clearing the draft', async () => {
        const { input, editor } = await openFiles();
        editor.commands.setTextSelection({ from: 1, to: 5 });
        input.vm.insertTextAtCursor('Please read @');
        await flushPromises();
        expect(wrapper.find('[data-testid="quick-search-panel"]').exists()).toBe(false);
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Escape' });
        await flushPromises();
        expect(input.vm.captureInputHistorySnapshot().text).toBe('Please read @');
        expect((wrapper.vm as InstanceType<typeof FileSearchInput>).fileQuery).toBeNull();
        editor.view.dom.blur();
        editor.view.dom.focus();
        await flushPromises();
        expect((wrapper.vm as InstanceType<typeof FileSearchInput>).fileQuery).toBeNull();
        input.vm.insertTextAtCursor('read');
        await flushPromises();
        expect((wrapper.vm as InstanceType<typeof FileSearchInput>).fileQuery).toBe('read');
        await vi.waitFor(() => expect(wrapper.findAll('[role="option"]')).toHaveLength(2));
    });

    it('user given one reference when typing @ again then clicks a second file and can undo only that insertion', async () => {
        const { input, panel } = await openFiles();
        panel.vm.moveSelection('down');
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        await flushPromises();
        input.vm.insertTextAtCursor('@read');
        await flushPromises();
        await vi.waitFor(() =>
            expect(wrapper.findAll('[data-slot="result-item"]')).toHaveLength(2)
        );
        const row = wrapper.findAll('[data-slot="result-item"]')[1]!;
        await row.trigger('mousedown');
        await row.trigger('click');
        await flushPromises();
        expect(input.vm.captureInputHistorySnapshot().attachments.map((file) => file.name)).toEqual(
            ['README.md', 'README-contributing.md']
        );
        const editor = wrapper.getComponent(EditorContent).props('editor')!;
        editor.commands.undo();
        await flushPromises();
        expect(input.vm.captureInputHistorySnapshot().text).toBe(' @read');
        expect(input.vm.captureInputHistorySnapshot().attachments).toHaveLength(1);
    });

    it.each(['hello@example.com', 'https://example.com/@read', 'git@github.com:repo'])(
        'user given %s when typing then keeps it as ordinary text',
        async (text) => {
            const { input, editor } = await openFiles();
            editor.commands.setTextSelection({ from: 1, to: 5 });
            input.vm.insertTextAtCursor(text);
            await flushPromises();
            expect((wrapper.vm as InstanceType<typeof FileSearchInput>).fileQuery).toBeNull();
        }
    );

    it('user given an active @ query when search fails then keeps the draft and recovers by typing', async () => {
        const { input, editor } = await openFiles();
        mockTauriCommand('quick_search_search_shortcuts', () => {
            throw new Error('Index unavailable');
        });
        editor.commands.setTextSelection({ from: 1, to: 5 });
        input.vm.insertTextAtCursor('Read @missing');
        await vi.waitFor(() =>
            expect(
                getTauriInvokeCalls('quick_search_search_shortcuts').some(
                    (call) => (call.payload as { query: string }).query === 'missing'
                )
            ).toBe(true)
        );
        await flushPromises();
        expect(wrapper.find('[data-testid="quick-search-panel"]').exists()).toBe(false);
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Enter' });
        expect(input.vm.captureInputHistorySnapshot().text).toBe('Read @missing');
        expect(wrapper.find('[data-attachment-tag]').exists()).toBe(false);
        mockTauriCommand('quick_search_search_shortcuts', {
            shortcuts: [],
            files: [],
            total_files: 0,
            total_results: 0,
            next_offset: 0,
        });
        input.vm.insertTextAtCursor('x');
        await vi.waitFor(() =>
            expect(
                getTauriInvokeCalls('quick_search_search_shortcuts').some(
                    (call) => (call.payload as { query: string }).query === 'missingx'
                )
            ).toBe(true)
        );
        await flushPromises();
        expect(wrapper.find('[data-testid="quick-search-panel"]').exists()).toBe(false);
        expect((wrapper.vm as InstanceType<typeof FileSearchInput>).fileQuery).toBe('missingx');
        mockTauriCommand('quick_search_search_shortcuts', {
            shortcuts: [],
            files,
            total_files: 2,
            total_results: 2,
            next_offset: 2,
        });
        input.vm.insertTextAtCursor('y');
        await vi.waitFor(() => expect(wrapper.findAll('[role="option"]')).toHaveLength(2));
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        expect(input.vm.captureInputHistorySnapshot().text).toBe('Read  ');
    });

    it('user given pending replacement results when clicking an old row or pressing Enter then cannot accept stale files', async () => {
        const { input, editor } = await openFiles();
        editor.commands.setTextSelection({ from: 1, to: 5 });
        input.vm.insertTextAtCursor('Read @read');
        await vi.waitFor(() => expect(wrapper.findAll('[role="option"]')).toHaveLength(2));
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
        const staleRow = wrapper.get('[role="option"]');
        let finish!: (value: unknown) => void;
        mockTauriCommand(
            'quick_search_search_shortcuts',
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        input.vm.insertTextAtCursor('x');
        await staleRow.trigger('click');
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Enter' });
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        expect(input.vm.captureInputHistorySnapshot().attachments).toEqual([]);
        expect(input.vm.captureInputHistorySnapshot().text).toBe('Read @readx');
        finish({ shortcuts: [], files: [], total_files: 0, total_results: 0, next_offset: 0 });
        await flushPromises();
        expect(wrapper.find('[data-testid="quick-search-panel"]').exists()).toBe(false);
    });

    it('user given visible file references when editing the keyword then keeps the same panel until replacement results arrive', async () => {
        const { input, editor } = await openFiles();
        editor.commands.setTextSelection({ from: 1, to: 5 });
        input.vm.insertTextAtCursor('Read @read');
        await vi.waitFor(() => expect(wrapper.findAll('[role="option"]')).toHaveLength(2));
        const panelElement = wrapper.get('[data-testid="quick-search-panel"]').element;
        const viewport = wrapper.get('[data-slot="result-panel-viewport"]').element;
        const replacement = [{ name: 'release.md', path: 'D:/docs/release.md', source: 'file' }];
        let finish!: (value: unknown) => void;
        mockTauriCommand(
            'quick_search_search_shortcuts',
            () => new Promise((resolve) => (finish = resolve))
        );

        input.vm.insertTextAtCursor('x');
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));

        expect(wrapper.get('[data-testid="quick-search-panel"]').element).toBe(panelElement);
        expect(wrapper.get('[data-slot="result-panel-viewport"]').element).toBe(viewport);
        expect(viewport.getAttribute('aria-busy')).toBe('true');
        expect(wrapper.findAll('[role="option"]').map((row) => row.text())).toEqual(
            expect.arrayContaining(files.map((file) => expect.stringContaining(file.name)))
        );
        await wrapper.get('[role="option"]').trigger('click');
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        expect(input.vm.captureInputHistorySnapshot().attachments).toEqual([]);
        expect(wrapper.get('[data-slot="result-panel-footer"]').text()).not.toContain('Tab');

        finish({
            shortcuts: [],
            files: replacement,
            total_files: 1,
            total_results: 1,
            next_offset: 1,
        });
        await flushPromises();

        expect(wrapper.get('[data-testid="quick-search-panel"]').element).toBe(panelElement);
        expect(viewport.getAttribute('aria-busy')).toBe('false');
        expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
        expect(wrapper.get('[role="option"]').text()).toContain('release.md');
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        expect(input.vm.captureInputHistorySnapshot().attachments[0]?.name).toBe('release.md');
    });

    it('user given a pending keyword change when returning to the previous keyword then keeps its matches after the obsolete request fails', async () => {
        const { input, editor } = await openFiles();
        editor.commands.setTextSelection({ from: 1, to: 5 });
        input.vm.insertTextAtCursor('Read @read');
        await vi.waitFor(() => expect(wrapper.findAll('[role="option"]')).toHaveLength(2));
        const panelElement = wrapper.get('[data-testid="quick-search-panel"]').element;
        let fail!: (reason: Error) => void;
        mockTauriCommand(
            'quick_search_search_shortcuts',
            () => new Promise((_, reject) => (fail = reject))
        );
        input.vm.insertTextAtCursor('x');
        await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
        editor.commands.deleteRange({
            from: editor.state.selection.from - 1,
            to: editor.state.selection.from,
        });
        await flushPromises();
        fail(new Error('Obsolete query failed'));
        await flushPromises();

        expect(wrapper.get('[data-testid="quick-search-panel"]').element).toBe(panelElement);
        expect(input.vm.captureInputHistorySnapshot().text).toBe('Read @read');
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        expect(input.vm.captureInputHistorySnapshot().attachments[0]?.name).toBe('README.md');
    });

    it.each([{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }, { ctrlKey: true }])(
        'user given an @ query when composing or modifying acceptance %j then keeps the draft',
        async (modifiers) => {
            const { input, editor } = await openFiles();
            editor.commands.setTextSelection({ from: 1, to: 5 });
            input.vm.insertTextAtCursor('Read @read');
            await vi.waitFor(() => expect(wrapper.findAll('[role="option"]')).toHaveLength(2));
            await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
            await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab', ...modifiers });
            expect(input.vm.captureInputHistorySnapshot().attachments).toEqual([]);
            expect(input.vm.captureInputHistorySnapshot().text).toBe('Read @read');
        }
    );

    it('user given an @ query when moving sideways before selecting a result then keeps normal caret movement', async () => {
        const { input, editor } = await openFiles();
        editor.commands.setTextSelection({ from: 1, to: 5 });
        input.vm.insertTextAtCursor('Read @read');
        editor.commands.setTextSelection('Read @re'.length + 1);
        await flushPromises();
        await vi.waitFor(() =>
            expect(wrapper.get('[data-slot="result-panel-viewport"]').attributes('aria-busy')).toBe(
                'false'
            )
        );
        await vi.waitFor(() => expect(wrapper.findAll('[role="option"]')).toHaveLength(2));
        // ProseMirror delegates text movement to the native browser; jsdom has no caret layout.
        expect(
            editor.view.props.handleKeyDown?.(
                editor.view,
                new KeyboardEvent('keydown', { key: 'ArrowRight' })
            )
        ).toBe(false);
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowDown' });
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'ArrowRight' });
        expect(editor.state.selection.from).toBe('Read @re'.length + 1);
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        expect(input.vm.captureInputHistorySnapshot().attachments.map((file) => file.name)).toEqual(
            ['README-contributing.md']
        );
    });

    it('user given unselected file results when pressing Tab then keeps the draft until a candidate is selected', async () => {
        const { input, panel } = await openFiles();
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        await flushPromises();
        expect(input.vm.captureInputHistorySnapshot().attachments).toEqual([]);
        expect(input.vm.captureInputHistorySnapshot().text).toBe('read');
        expect(document.activeElement).toBe(wrapper.get('.ProseMirror').element);
        panel.vm.moveSelection('down');
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        await flushPromises();

        expect(wrapper.get('[data-attachment-tag]').text()).toBe('README.md');
        expect(input.vm.captureInputHistorySnapshot()).toMatchObject({
            text: ' ',
            attachments: [{ name: 'README.md', path: files[0]!.path, type: 'file' }],
        });
        expect(document.activeElement).toBe(wrapper.get('.ProseMirror').element);
        expect(getTauriInvokeCalls('plugin:opener|open_path')).toEqual([]);
        expect(getTauriInvokeCalls('plugin:fs-pro|icon')).toEqual([]);
    });

    it('user selects a different file and replaces only the token around the caret', async () => {
        const { input, panel, editor } = await openFiles();
        input.vm.restoreInputHistorySnapshot({
            text: 'Please read README afterwards',
            attachments: [],
        });
        await flushPromises();
        panel.vm.open();
        await flushPromises();
        editor.commands.setTextSelection('Please read REA'.length + 1);
        panel.vm.moveSelection('down');
        panel.vm.moveSelection('down');
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        await flushPromises();

        expect(wrapper.get('[data-attachment-tag]').text()).toBe('README-contributing.md');
        expect(input.vm.captureInputHistorySnapshot().text).toBe('Please read  afterwards');
        input.vm.insertTextAtCursor('carefully ');
        expect(input.vm.captureInputHistorySnapshot().text).toBe(
            'Please read  carefully afterwards'
        );
    });

    it('user replaces selected text with a file and undoes the completion independently of typing', async () => {
        const { input, panel, editor } = await openFiles();
        editor.commands.setTextSelection({ from: 1, to: 5 });
        input.vm.insertTextAtCursor('Read the selected document later');
        await flushPromises();
        panel.vm.open();
        await flushPromises();
        editor.commands.setTextSelection({ from: 6, to: 27 });
        panel.vm.moveSelection('down');
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        await flushPromises();
        const snapshot = input.vm.captureInputHistorySnapshot();
        expect(snapshot.text).toBe('Read  later');

        editor.commands.undo();
        await flushPromises();
        expect(input.vm.captureInputHistorySnapshot().text).toBe(
            'Read the selected document later'
        );
        expect(input.vm.captureInputHistorySnapshot().attachments).toEqual([]);

        editor.commands.redo();
        await flushPromises();
        expect(input.vm.captureInputHistorySnapshot()).toEqual(snapshot);

        // History recall restores the existing attachment node and metadata together.
        (wrapper as VueWrapper<InstanceType<typeof FileSearchInput>>).vm.recall(snapshot);
        await flushPromises();
        expect(input.vm.captureInputHistorySnapshot()).toEqual(snapshot);
    });

    it.each([
        { isComposing: true },
        { keyCode: 229 },
        { shiftKey: true },
        { ctrlKey: true },
        { metaKey: true },
        { altKey: true },
    ])('user presses modified or composing Tab and keeps the draft %j', async (modifiers) => {
        const { input, panel } = await openFiles();
        panel.vm.moveSelection('down');
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab', ...modifiers });
        expect(wrapper.find('[data-attachment-tag]').exists()).toBe(false);
        expect(input.vm.captureInputHistorySnapshot().text).toBe('read');
    });

    it('user changes the query then presses Tab and cannot reference stale results', async () => {
        const { input, editor, panel } = await openFiles();
        panel.vm.moveSelection('down');
        editor.commands.setTextSelection({ from: 1, to: 5 });
        input.vm.insertTextAtCursor('different');
        await flushPromises();
        const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        editor.view.dom.dispatchEvent(event);
        await flushPromises();
        expect(event.defaultPrevented).toBe(true);
        expect(wrapper.find('[data-attachment-tag]').exists()).toBe(false);
        expect(input.vm.captureInputHistorySnapshot().text).toBe('different');
    });

    it('user holds Tab after completion and keeps one reference and editor focus', async () => {
        const { panel } = await openFiles();
        panel.vm.moveSelection('down');
        await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Tab' });
        await flushPromises();
        const event = new KeyboardEvent('keydown', {
            key: 'Tab',
            repeat: true,
            bubbles: true,
            cancelable: true,
        });
        wrapper.get('.ProseMirror').element.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(wrapper.findAll('[data-attachment-tag]')).toHaveLength(1);
    });
});
