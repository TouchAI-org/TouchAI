import { mountComposable } from '@tests/utils/composables';
import { installSkillCommands, skillFile } from '@tests/utils/skills';
import { mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, ref } from 'vue';

import { createDefaultSearchKeybindings } from '@/config/searchKeybindings';
import type { PendingToolApproval, SessionMessage } from '@/types/session';
import SearchBar from '@/views/SearchView/components/SearchBar/index.vue';
import type { UseSearchKeyboardOptions } from '@/views/SearchView/composables/searchInteraction';
import {
    useSearchKeyboard,
    useSearchPageController,
} from '@/views/SearchView/composables/useSearchPage';
import type {
    PendingRequest,
    SearchBarHandle,
    SearchPageController,
} from '@/views/SearchView/types';

vi.mock('@/stores/askUser', () => ({
    useAskUserStore: () => ({ current: null }),
}));

function createControllerStub(): SearchPageController {
    return {
        focusConversation: vi.fn(),
        focusSearchInput: vi.fn().mockResolvedValue(undefined),
        loadActiveModel: vi.fn().mockResolvedValue(undefined),
        prefetchModelDropdownData: vi.fn().mockResolvedValue(undefined),
        invalidateModelDropdownData: vi.fn(),
        prepareModelDropdownOpen: vi.fn().mockResolvedValue(undefined),
        selectModelFromDropdown: vi.fn().mockResolvedValue({ modelId: null, providerId: null }),
        getModelDropdownAnchor: vi.fn(() => null),
        getModelDropdownContext: vi.fn(() => ({
            activeModelId: null,
            activeProviderId: null,
            selectedModelId: null,
            selectedProviderId: null,
            models: [],
        })),
        isQuickSearchOpen: vi.fn(() => false),
        isQuickSearchItemHighlighted: vi.fn(() => false),
        isSkillAutocompleteOpen: () => false,
        isSkillAutocompleteActive: () => false,
        closeSkillAutocomplete: vi.fn(),
        hasInputContent: () => false,
        openQuickSearch: vi.fn(),
        closeQuickSearch: vi.fn(),
        settleQuickSearchInteraction: vi.fn(),
        moveQuickSearchSelection: vi.fn(),
        openHighlightedQuickSearchItem: vi.fn().mockResolvedValue(undefined),
        triggerQuickSearch: vi.fn(),
        goToPageQuickSearch: vi.fn(),
        goToNextPageQuickSearch: vi.fn(),
        goToPreviousPageQuickSearch: vi.fn(),
        openQuickSearchContextMenu: vi.fn(),
        toggleQuickSearchView: vi.fn(),
        collapseQuickSearch: vi.fn(),
        isQuickSearchContextMenuOpen: vi.fn(() => false),
        closeQuickSearchContextMenu: vi.fn(),
    };
}

function createOptions({
    modelDropdownOpen = false,
    sessionHistoryOpen = false,
}: {
    modelDropdownOpen?: boolean;
    sessionHistoryOpen?: boolean;
} = {}): UseSearchKeyboardOptions {
    return {
        viewReady: ref(true),
        queryText: ref(''),
        attachments: ref([]),
        cursorContext: ref({
            isMultiLine: false,
            cursorAtStart: true,
            cursorAtTextStart: true,
            cursorAtEnd: true,
        }),
        modelOverride: ref({ modelId: null, providerId: null }),
        modelDropdownState: ref({ isOpen: modelDropdownOpen }),
        controller: createControllerStub(),
        sessionHistory: ref<SessionMessage[]>([]),
        pendingRequest: ref<PendingRequest | null>(null),
        isLoading: ref(false),
        pendingToolApproval: ref<PendingToolApproval | null>(null),
        approvePendingToolApproval: vi.fn(() => false),
        rejectPendingToolApproval: vi.fn(() => false),
        promptPendingToolApprovalAttention: vi.fn(),
        getActiveOverlaySurface: vi.fn(() => null),
        isQuickSearchOpen: computed(() => false),
        shouldTriggerQuickSearch: vi.fn(() => false),
        sessionHistoryOverlayOpen: ref(sessionHistoryOpen),
        hideAllOverlays: vi.fn().mockResolvedValue(undefined),
        hideSearchWindow: vi.fn().mockResolvedValue(undefined),
        navigateInputHistory: vi.fn(() => 'ignored' as const),
        closeModelDropdown: vi.fn().mockResolvedValue(undefined),
        toggleWindowMaximize: vi.fn().mockResolvedValue(undefined),
        handleSubmit: vi.fn().mockResolvedValue(undefined),
        clearAll: vi.fn(),
        cancelRequest: vi.fn(),
        clearSession: vi.fn(),
    };
}

describe('useSearchKeyboard outside-click handling', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('dismisses and consumes a document-capture mousedown outside the model overlay', async () => {
        const options = createOptions({ modelDropdownOpen: true });
        const mounted = await mountComposable(() => useSearchKeyboard(options));
        const outsideTarget = document.createElement('button');
        const targetMouseDown = vi.fn();
        outsideTarget.addEventListener('mousedown', targetMouseDown);
        document.body.appendChild(outsideTarget);

        const event = new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
        });
        const preventDefault = vi.spyOn(event, 'preventDefault');
        const stopPropagation = vi.spyOn(event, 'stopPropagation');

        outsideTarget.dispatchEvent(event);

        expect(options.hideAllOverlays).toHaveBeenCalledTimes(1);
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
        expect(targetMouseDown).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('dismisses session history while allowing the initiating mousedown to continue', async () => {
        const options = createOptions({ sessionHistoryOpen: true });
        const mounted = await mountComposable(() => useSearchKeyboard(options));
        const outsideTarget = document.createElement('button');
        const targetMouseDown = vi.fn();
        outsideTarget.addEventListener('mousedown', targetMouseDown);
        document.body.appendChild(outsideTarget);

        const event = new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
        });
        const preventDefault = vi.spyOn(event, 'preventDefault');
        const stopPropagation = vi.spyOn(event, 'stopPropagation');

        outsideTarget.dispatchEvent(event);

        expect(options.hideAllOverlays).toHaveBeenCalledTimes(1);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(stopPropagation).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
        expect(targetMouseDown).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });

    it.each([
        [
            'the logo drag surface',
            () => {
                const element = document.createElement('div');
                element.className = 'logo-container';
                return element;
            },
        ],
        [
            'the history trigger',
            () => {
                const element = document.createElement('button');
                element.dataset.historyTrigger = 'true';
                return element;
            },
        ],
        [
            'content inside the overlay host',
            () => {
                const host = document.createElement('div');
                host.dataset.searchOverlayHost = 'true';
                const element = document.createElement('button');
                host.appendChild(element);
                document.body.appendChild(host);
                return element;
            },
        ],
    ])('exempts mousedown on %s from global overlay dismissal', async (_label, createTarget) => {
        const options = createOptions({ modelDropdownOpen: true, sessionHistoryOpen: true });
        const mounted = await mountComposable(() => useSearchKeyboard(options));
        const target = createTarget();
        if (!target.isConnected) {
            document.body.appendChild(target);
        }
        const targetMouseDown = vi.fn();
        target.addEventListener('mousedown', targetMouseDown);

        const event = new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
        });
        target.dispatchEvent(event);

        expect(options.hideAllOverlays).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
        expect(targetMouseDown).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });
});

describe('useSearchKeyboard inline overlay inputs', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    function dispatchOverlayKeydown(key: string, modifiers: KeyboardEventInit = {}) {
        const host = document.createElement('div');
        host.dataset.searchOverlayHost = 'true';
        const input = document.createElement('input');
        host.appendChild(input);
        document.body.appendChild(host);

        const event = new KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
            ...modifiers,
        });
        input.dispatchEvent(event);
        return event;
    }

    it.each(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab', 'Escape'])(
        'user given an @ picker in a conversation when pressing %s then the editor owns the completion key',
        async (key) => {
            const options = createOptions();
            options.queryText.value = 'Please read @file';
            options.controller.isFileAutocompleteOpen = () => true;
            options.isQuickSearchOpen = computed(() => true);
            options.controller.isQuickSearchItemHighlighted = () => true;
            options.sessionHistory.value = [
                { id: 'prior', role: 'user', content: 'prior', parts: [], timestamp: 1 },
            ];
            const mounted = await mountComposable(() => useSearchKeyboard(options));
            try {
                const event = new KeyboardEvent('keydown', {
                    key,
                    bubbles: true,
                    cancelable: true,
                });
                window.dispatchEvent(event);
                expect(event.defaultPrevented).toBe(false);
                expect(options.handleSubmit).not.toHaveBeenCalled();
                expect(options.controller.openHighlightedQuickSearchItem).not.toHaveBeenCalled();
                expect(options.controller.focusConversation).not.toHaveBeenCalled();
                expect(options.navigateInputHistory).not.toHaveBeenCalled();
                expect(options.queryText.value).toBe('Please read @file');
            } finally {
                mounted.unmount();
            }
        }
    );

    it.each([
        { key: 'ArrowLeft' },
        { key: 'PageDown' },
        { key: 'Backspace', ctrlKey: true },
        { key: 'Enter', shiftKey: true },
        { key: 'ArrowDown', ctrlKey: true, shiftKey: true },
    ])(
        'user edits an overlay filter with $key without operating the underlying search',
        async (input) => {
            const options = createOptions({ modelDropdownOpen: true });
            options.isQuickSearchOpen = computed(() => true);
            options.controller.isQuickSearchItemHighlighted = () => true;
            options.queryText.value = 'underlying draft';
            const mounted = await mountComposable(() => useSearchKeyboard(options));
            const event = dispatchOverlayKeydown(input.key, input);
            expect(event.defaultPrevented).toBe(false);
            expect(options.clearAll).not.toHaveBeenCalled();
            expect(options.controller.moveQuickSearchSelection).not.toHaveBeenCalled();
            expect(options.controller.goToNextPageQuickSearch).not.toHaveBeenCalled();
            expect(options.controller.openHighlightedQuickSearchItem).not.toHaveBeenCalled();
            mounted.unmount();
        }
    );

    it.each([
        { shortcut: 'Mod+Shift+,', key: '<', code: 'Comma', ctrlKey: true, shiftKey: true },
        { shortcut: 'F11', key: 'BrightnessUp', code: 'F11' },
    ])('user invokes a captured $shortcut binding using its physical key code', async (input) => {
        const options = createOptions();
        options.searchKeybindings = ref({
            ...createDefaultSearchKeybindings(),
            'search.window.pin': input.shortcut,
            'search.window.maximize': null,
        });
        options.handleSearchKeybindingAction = vi.fn();
        const mounted = await mountComposable(() => useSearchKeyboard(options));
        window.dispatchEvent(
            new KeyboardEvent('keydown', { ...input, bubbles: true, cancelable: true })
        );
        expect(options.handleSearchKeybindingAction).toHaveBeenCalledWith('search.window.pin');
        mounted.unmount();
    });

    it.each([
        { key: 'Enter', shiftKey: true },
        { key: 'ArrowLeft', ctrlKey: true },
        { key: 'ArrowDown', ctrlKey: true, shiftKey: true },
    ])(
        'user keeps editing with modified $key while a search result is highlighted',
        async (input) => {
            const options = createOptions();
            options.isQuickSearchOpen = computed(() => true);
            options.controller.isQuickSearchItemHighlighted = () => true;
            options.queryText.value = 'draft';
            const mounted = await mountComposable(() => useSearchKeyboard(options));
            const event = new KeyboardEvent('keydown', {
                ...input,
                bubbles: true,
                cancelable: true,
            });
            window.dispatchEvent(event);
            expect(event.defaultPrevented).toBe(false);
            expect(options.handleSubmit).not.toHaveBeenCalled();
            expect(options.controller.moveQuickSearchSelection).not.toHaveBeenCalled();
            expect(options.controller.openHighlightedQuickSearchItem).not.toHaveBeenCalled();
            mounted.unmount();
        }
    );

    it('keeps the model dropdown open when Backspace edits its filter input', async () => {
        const options = createOptions({ modelDropdownOpen: true });
        const mounted = await mountComposable(() => useSearchKeyboard(options));

        const event = dispatchOverlayKeydown('Backspace');

        expect(options.closeModelDropdown).not.toHaveBeenCalled();
        expect(options.modelDropdownState.value.isOpen).toBe(true);
        expect(event.defaultPrevented).toBe(false);

        mounted.unmount();
    });

    it('preserves the draft model selection when Backspace edits history filter input', async () => {
        const options = createOptions({ sessionHistoryOpen: true });
        options.modelOverride.value = { modelId: 'gpt-5', providerId: 2 };
        const mounted = await mountComposable(() => useSearchKeyboard(options));

        const event = dispatchOverlayKeydown('Backspace');

        expect(options.modelOverride.value).toEqual({ modelId: 'gpt-5', providerId: 2 });
        expect(options.closeModelDropdown).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);

        mounted.unmount();
    });

    it('does not move focus to the conversation when Tab is pressed in an overlay filter', async () => {
        const options = createOptions({ modelDropdownOpen: true });
        options.sessionHistory.value = [
            {
                id: 'history-1',
                role: 'user',
                content: 'history',
                parts: [],
                timestamp: 1,
            },
        ];
        const mounted = await mountComposable(() => useSearchKeyboard(options));

        const event = dispatchOverlayKeydown('Tab');

        expect(options.controller.focusConversation).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);

        mounted.unmount();
    });
});

describe('given a skill picker owns the editor result slot', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it.each(
        ['$', '/'].flatMap((prefix) =>
            ['Tab', 'Enter'].flatMap((key) =>
                [true, false].map((matched) => ({ prefix, key, matched }))
            )
        )
    )(
        'user given a $prefix completion with matched=$matched when pressing $key through the page then keeps the action in the editor',
        async ({ prefix, key, matched }) => {
            const rangeDescriptors = ['getClientRects', 'getBoundingClientRect'].map((name) => ({
                name,
                descriptor: Object.getOwnPropertyDescriptor(Range.prototype, name),
            }));
            // JSDOM has no layout; ProseMirror still measures the browser selection.
            Object.defineProperties(Range.prototype, {
                getClientRects: { configurable: true, value: () => [] },
                getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
            });
            installSkillCommands();
            mockTauriCommand('database_query', {
                rows: [],
                rowsAffected: 0,
                lastInsertId: null,
            });
            const options = createOptions();
            options.sessionHistory.value = [
                { id: 'prior', role: 'user', content: 'prior', parts: [], timestamp: 1 },
            ];
            const searchBar = ref<SearchBarHandle>();
            const component = defineComponent({
                setup() {
                    options.controller = useSearchPageController({
                        searchBar,
                        quickSearchOpen: ref(false),
                        quickSearchPanel: ref(),
                        conversationPanel: ref(),
                    });
                    useSearchKeyboard(options);
                    return () =>
                        h(SearchBar, {
                            ref: searchBar,
                            queryText: options.queryText.value,
                            'onUpdate:queryText': (value: string) => {
                                options.queryText.value = value;
                            },
                            startDragging: async () => {},
                        });
                },
            });
            const wrapper = mount(component, {
                attachTo: document.body,
                global: { plugins: [createPinia()] },
            });
            const focusConversation = vi.spyOn(options.controller, 'focusConversation');
            const openFile = vi.spyOn(options.controller, 'openHighlightedQuickSearchItem');
            try {
                await flushPromises();
                const editor = wrapper.get<HTMLElement>('.ProseMirror');
                editor.element.focus();
                await flushPromises();
                const draft = `${prefix}${matched ? 'sum' : 'zz-missing-skill'}`;
                searchBar.value!.insertTextAtCursor(draft);
                await flushPromises();
                expect(editor.attributes('aria-expanded')).toBe(String(matched));
                expect(wrapper.find('[data-inline-completion]').exists()).toBe(matched);

                const event = new KeyboardEvent('keydown', {
                    key,
                    bubbles: true,
                    cancelable: true,
                });
                editor.element.dispatchEvent(event);
                await flushPromises();

                expect(options.handleSubmit).not.toHaveBeenCalled();
                expect(focusConversation).not.toHaveBeenCalled();
                expect(openFile).not.toHaveBeenCalled();
                expect(options.navigateInputHistory).not.toHaveBeenCalled();
                expect(event.defaultPrevented).toBe(true);
                expect(document.activeElement).toBe(editor.element);
                if (matched) {
                    expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');
                    expect(searchBar.value!.captureInputHistorySnapshot().skills).toEqual([
                        { name: 'summary', path: skillFile().path },
                    ]);
                } else {
                    expect(wrapper.find('[data-skill-tag]').exists()).toBe(false);
                    expect(searchBar.value!.captureInputHistorySnapshot().text).toBe(draft);
                }
            } finally {
                await new Promise(requestAnimationFrame);
                wrapper.unmount();
                for (const { name, descriptor } of rangeDescriptors) {
                    if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
                    else Reflect.deleteProperty(Range.prototype, name);
                }
            }
        }
    );

    it.each(['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'])(
        'user can use %s in the skill picker without operating the conversation or file results',
        async (key) => {
            const options = createOptions();
            options.queryText.value = '/review';
            options.sessionHistory.value = [
                {
                    id: 'previous',
                    role: 'user',
                    content: 'previous prompt',
                    parts: [],
                    timestamp: 1,
                },
            ];
            options.controller.isSkillAutocompleteOpen = () => true;
            options.controller.isSkillAutocompleteActive = () => true;
            const mounted = await mountComposable(() => useSearchKeyboard(options));
            const editor = document.createElement('div');
            editor.contentEditable = 'true';
            document.body.appendChild(editor);
            let receivedByPicker = false;
            editor.addEventListener('keydown', () => {
                receivedByPicker = true;
            });

            try {
                const event = new KeyboardEvent('keydown', {
                    key,
                    bubbles: true,
                    cancelable: true,
                });
                editor.dispatchEvent(event);

                expect(receivedByPicker).toBe(true);
                expect(event.defaultPrevented).toBe(false);
                expect(options.queryText.value).toBe('/review');
                expect(options.handleSubmit).not.toHaveBeenCalled();
                expect(options.navigateInputHistory).not.toHaveBeenCalled();
                expect(options.controller.focusConversation).not.toHaveBeenCalled();
                expect(options.hideSearchWindow).not.toHaveBeenCalled();
            } finally {
                mounted.unmount();
            }
        }
    );
});
