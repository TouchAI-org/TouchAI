import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

const { isMultiLine, useSearchInputMock } = vi.hoisted(() => {
    const fakeRef = <T>(value: T) => ({
        __v_isRef: true,
        value,
    });
    const isMultiLine = fakeRef(false);
    return {
        isMultiLine,
        useSearchInputMock: vi.fn(() => ({
            editor: fakeRef({}),
            selectedModel: fakeRef(null),
            activeModel: fakeRef({
                model_id: 'mimo-v2.5',
                name: 'mimo-v2.5',
            }),
            prefetchModelDropdownData: vi.fn(),
            invalidateModelDropdownData: vi.fn(),
            prepareModelDropdownOpen: vi.fn(),
            selectModelFromDropdown: vi.fn(),
            getModelDropdownAnchor: vi.fn(),
            getModelDropdownContext: vi.fn(),
            isMultiLine,
            cursorAtStart: fakeRef(false),
            cursorAtTextStart: fakeRef(true),
            cursorAtEnd: fakeRef(true),
            focus: vi.fn(),
            loadActiveModel: vi.fn(),
            captureInputHistorySnapshot: vi.fn(),
            restoreInputHistorySnapshot: vi.fn(),
            handleContainerMouseDown: vi.fn(),
            handleEditorMouseDown: vi.fn(),
            initEditor: vi.fn(),
            destroyEditor: vi.fn(),
            onEditorClick: vi.fn(),
            logoContainerRef: fakeRef(null),
        })),
    };
});

vi.mock('@assets/logo.svg', () => ({ default: 'logo.svg' }));

vi.mock('@components/ModelLogo.vue', () => ({
    default: {
        name: 'ModelLogo',
        props: ['modelId', 'name'],
        template: '<div class="mock-model-logo" />',
    },
}));

vi.mock('@tiptap/vue-3', () => ({
    EditorContent: {
        name: 'EditorContent',
        props: ['editor'],
        template: '<div class="mock-editor-content" />',
    },
}));

vi.mock('@/views/SearchView/components/SearchBar/composables/useSearchLogic', () => ({
    useSearchInput: useSearchInputMock,
}));

import SearchBar from '@/views/SearchView/components/SearchBar/index.vue';

describe('when the user types into the search bar', () => {
    beforeEach(() => {
        isMultiLine.value = false;
        useSearchInputMock.mockClear();
    });

    function mountSearchBar() {
        return mount(SearchBar, {
            props: {
                queryText: '',
                attachments: [],
                modelOverride: {
                    modelId: null,
                    providerId: null,
                },
            },
        });
    }

    it('user sees a single-line draft vertically centred in the window', () => {
        const wrapper = mountSearchBar();

        const searchBar = wrapper.get('[data-testid="search-bar"]');

        expect(searchBar.classes()).toContain('items-center');
        expect(searchBar.classes()).not.toContain('items-start');
    });

    it('user sees the draft top-aligned once it wraps to several lines', async () => {
        const wrapper = mountSearchBar();

        isMultiLine.value = true;
        wrapper.vm.$forceUpdate();
        await nextTick();

        const searchBar = wrapper.get('[data-testid="search-bar"]');

        expect(searchBar.classes()).toContain('items-start');
        expect(searchBar.classes()).not.toContain('items-center');
    });

    it('user gets at most seven visible lines before the draft scrolls', () => {
        const wrapper = mountSearchBar();

        const editorHost = wrapper.get('[data-testid="search-editor-host"]');

        expect(editorHost.attributes('style')).toContain('max-height: calc(10.5em + 8px)');
    });
});
