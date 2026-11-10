import { mockTauriCommand } from '@tests/utils/tauri';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SearchBar from '@/views/SearchView/components/SearchBar/index.vue';

enableAutoUnmount(afterEach);
const rangeDescriptors = ['getClientRects', 'getBoundingClientRect'].map((name) => ({
    name,
    descriptor: Object.getOwnPropertyDescriptor(Range.prototype, name),
}));

describe('given the main input displays a draft', () => {
    beforeEach(() => {
        mockTauriCommand('database_query', { rows: [], rowsAffected: 0, lastInsertId: null });
        Object.defineProperties(Range.prototype, {
            getClientRects: { configurable: true, value: () => [] },
            getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
        });
    });
    afterEach(async () => {
        await new Promise(requestAnimationFrame);
        for (const { name, descriptor } of rangeDescriptors) {
            if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
            else Reflect.deleteProperty(Range.prototype, name);
        }
    });

    async function mountSearchBar() {
        const wrapper = mount(SearchBar, {
            props: {
                startDragging: vi.fn().mockResolvedValue(undefined),
                queryText: 'Draft',
            },
            global: { plugins: [createPinia()] },
        });
        await flushPromises();
        return wrapper;
    }

    it('user opens a single-line draft and sees it vertically centred in the window', async () => {
        const wrapper = await mountSearchBar();
        const searchBar = wrapper.get('[data-testid="search-bar"]');

        expect(wrapper.get('.ProseMirror').text()).toBe('Draft');
        expect(searchBar.classes()).toContain('items-center');
        expect(searchBar.classes()).not.toContain('items-start');
    });

    it('user opens the input and sees a content-sized row instead of a full-height panel', async () => {
        const wrapper = await mountSearchBar();
        const searchBar = wrapper.get('[data-testid="search-bar"]');

        expect(searchBar.classes()).not.toContain('h-full');
        expect(searchBar.classes()).toContain('min-h-14');
    });

    it('user restores a multiline draft and sees the input row align to its top', async () => {
        const wrapper = await mountSearchBar();
        wrapper.vm.restoreInputHistorySnapshot({
            text: 'First line\nSecond line',
            attachments: [],
        });
        await flushPromises();
        const searchBar = wrapper.get('[data-testid="search-bar"]');

        expect(wrapper.findAll('.ProseMirror p')).toHaveLength(2);
        expect(searchBar.classes()).toContain('items-start');
        expect(searchBar.classes()).not.toContain('items-center');
    });

    it('user opens the draft and gets at most seven visible lines before scrolling', async () => {
        const wrapper = await mountSearchBar();
        const editorHost = wrapper.get('[data-testid="search-editor-host"]');

        expect(editorHost.attributes('style')).toContain('max-height: calc(10.5em + 8px)');
    });
});
