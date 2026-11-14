import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';

import { useDragging } from '@/views/SearchView/components/SearchBar/composables/useDragging';

const { useSearchInputMock } = vi.hoisted(() => {
    const fakeRef = <T>(value: T) => ({
        __v_isRef: true,
        value,
    });
    return {
        useSearchInputMock: vi.fn(() => ({
            editor: fakeRef({ view: { dom: { blur: vi.fn() } }, setEditable: vi.fn() }),
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
            isMultiLine: fakeRef(false),
            skillAutocomplete: {
                activeTrigger: fakeRef(null),
                candidates: fakeRef([]),
                close: vi.fn(),
                error: fakeRef(false),
                highlightedIndex: fakeRef(0),
                isLoading: fakeRef(false),
                isOpen: fakeRef(false),
                query: fakeRef(''),
                selectSkill: vi.fn(),
            },
            fileAutocomplete: { close: vi.fn(), query: fakeRef(null) },
            fileInputActive: fakeRef(false),
            skillInputActive: fakeRef(false),
            selectedSkills: fakeRef([]),
            captureSearchActivationInput: vi.fn(),
            insertSkillAtCursor: vi.fn(),
            completeFileReference: vi.fn(),
            clearDraggingState: vi.fn(),
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

vi.mock('@assets/logos/models/deepseek.png', () => ({ default: 'deepseek.png' }));

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

describe('given the main input shows extension controls', () => {
    beforeEach(() => {
        useSearchInputMock.mockClear();
    });

    function mountSearchBar(props: Record<string, unknown> = {}) {
        return mount(SearchBar, {
            props: {
                startDragging: vi.fn().mockResolvedValue(undefined),
                queryText: '',
                attachments: [],
                modelOverride: {
                    modelId: null,
                    providerId: null,
                },
                ...props,
            },
        });
    }

    it('user opens models, conversations and attachments from the extension bar', async () => {
        const wrapper = mountSearchBar({ toolbarOpen: true });
        const toolbar = wrapper.get('[data-testid="search-extension-bar"]');
        expect(toolbar.get('[data-model-trigger]').text()).toContain('mimo-v2.5');
        await toolbar.get('[data-model-trigger]').trigger('click');
        await toolbar.get('[data-history-trigger]').trigger('click');
        await toolbar.get('[data-attachment-trigger]').trigger('click');
        await toolbar.get('[data-settings-trigger]').trigger('click');
        expect(wrapper.emitted('requestToggleModelDropdown')).toHaveLength(1);
        expect(wrapper.emitted('requestToggleHistory')).toHaveLength(1);
        expect(wrapper.emitted('requestAddAttachment')).toHaveLength(1);
        expect(wrapper.emitted('requestOpenSettings')).toHaveLength(1);
    });

    it('user expands the toolbar from the same handle that rests on the draft', async () => {
        const collapsed = mountSearchBar();
        const handle = collapsed.get('[data-testid="search-toolbar-handle"]');
        expect(handle.attributes('aria-expanded')).toBe('false');
        expect(collapsed.get('[data-testid="search-toolbar"]').attributes('inert')).toBeDefined();
        await handle.trigger('click');
        expect(collapsed.emitted('requestToggleToolbar')).toHaveLength(1);

        const expanded = mountSearchBar({ toolbarOpen: true });
        expect(
            expanded.get('[data-testid="search-toolbar-handle"]').attributes('aria-expanded')
        ).toBe('true');
        expect(expanded.get('[data-testid="search-toolbar"]').attributes('inert')).toBeUndefined();
    });

    it('user drags the input padding and moves the window while toolbar gestures stay local', async () => {
        const startDragging = vi.fn().mockResolvedValue(undefined);
        const dragging = useDragging({
            editor: shallowRef(null),
            startDragging,
            emitDragStart: vi.fn(),
            emitDragEnd: vi.fn(),
        });
        const createSearchInput = useSearchInputMock.getMockImplementation()!;
        useSearchInputMock.mockImplementationOnce(() => ({
            ...createSearchInput(),
            handleContainerMouseDown: dragging.handleContainerMouseDown,
        }));
        const wrapper = mountSearchBar({ toolbarOpen: true });
        await wrapper.get('[data-testid="search-input-row"]').trigger('mousedown', {
            button: 0,
            clientX: 10,
            clientY: 10,
        });
        window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 20, clientY: 20 }));
        await flushPromises();
        expect(startDragging).toHaveBeenCalledTimes(1);
        await wrapper.get('[data-attachment-trigger]').trigger('mousedown', { button: 0 });
        expect(startDragging).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it('user cannot change a locked draft through extension actions', async () => {
        const wrapper = mountSearchBar({ toolbarOpen: true });
        await wrapper.setProps({ disabled: true });
        for (const button of wrapper.findAll('[data-testid="search-extension-bar"] button')) {
            expect(button.attributes('disabled')).toBeDefined();
        }
    });
});
