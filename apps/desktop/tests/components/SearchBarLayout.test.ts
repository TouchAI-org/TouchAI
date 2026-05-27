import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const searchInputMock = vi.hoisted(() => ({
    useSearchInput: vi.fn(() => ({
        editor: ref(null),
        selectedModel: ref(null),
        activeModel: ref(null),
        logoContainerRef: ref(null),
        prefetchModelDropdownData: vi.fn(),
        invalidateModelDropdownData: vi.fn(),
        prepareModelDropdownOpen: vi.fn(),
        selectModelFromDropdown: vi.fn(),
        getModelDropdownAnchor: vi.fn(),
        getModelDropdownContext: vi.fn(),
        isMultiLine: ref(false),
        cursorAtStart: ref(true),
        cursorAtTextStart: ref(true),
        cursorAtEnd: ref(true),
        focus: vi.fn(),
        loadActiveModel: vi.fn(),
        captureInputHistorySnapshot: vi.fn(),
        restoreInputHistorySnapshot: vi.fn(),
        handleContainerMouseDown: vi.fn(),
        handleEditorMouseDown: vi.fn(),
        initEditor: vi.fn(),
        destroyEditor: vi.fn(),
        onEditorClick: vi.fn(),
    })),
}));

vi.mock('@assets/logo.svg', () => ({
    default: 'logo.svg',
}));

vi.mock('@components/ModelLogo.vue', () => ({
    default: {
        name: 'ModelLogoStub',
        template: '<div data-testid="model-logo" />',
    },
}));

vi.mock('@/views/SearchView/components/SearchBar/composables/useSearchLogic', () => ({
    useSearchInput: searchInputMock.useSearchInput,
}));

import SearchBar from '@/views/SearchView/components/SearchBar/index.vue';

describe('SearchBar layout', () => {
    it('lets editor content grow the search bar until the three-line scroll cap', () => {
        const wrapper = mount(SearchBar);

        const container = wrapper.get('[data-testid="search-bar"]');
        expect(container.classes()).toContain('min-h-14');
        expect(container.classes()).not.toContain('h-full');

        const editorHost = wrapper.get('[data-testid="search-editor-host"]');
        expect(editorHost.classes()).toContain('min-h-6');
        expect(editorHost.classes()).toContain('overflow-y-auto');
        expect(editorHost.classes()).not.toContain('min-h-0');
        expect(editorHost.classes()).not.toContain('self-stretch');
        expect(editorHost.attributes('style')).toContain('max-height: calc(4.5em + 8px)');

        wrapper.unmount();
    });
});
