import { mountComposable } from '@tests/utils/composables';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

const { currentWindowMock } = vi.hoisted(() => ({
    currentWindowMock: {
        isVisible: vi.fn(),
        isAlwaysOnTop: vi.fn(),
        setAlwaysOnTop: vi.fn(),
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => currentWindowMock,
}));

vi.mock('@services/NativeService', () => ({
    native: {
        window: {
            hideSearchWindow: vi.fn().mockResolvedValue(undefined),
        },
    },
}));

import {
    useSearchKeyboard,
    useSearchPageController,
    useSearchPanelFocusRestore,
    useSearchWindowPin,
} from '@/views/SearchView/composables/useSearchPage';
import type {
    SearchCursorContext,
    SearchModelOverride,
    SearchPageController,
} from '@/views/SearchView/types';

function createQuickSearchPanelStub() {
    return {
        open: vi.fn(),
        close: vi.fn(),
        syncClosedState: vi.fn(),
        moveSelection: vi.fn(),
        getHighlightedItem: vi.fn(() => null as unknown),
        openHighlightedItem: vi.fn().mockResolvedValue(undefined),
        triggerSearch: vi.fn(),
        goToPage: vi.fn(),
        goToNextPage: vi.fn(),
        goToPreviousPage: vi.fn(),
        openContextMenuForItem: vi.fn(),
        openContextMenuForHighlightedItem: vi.fn(),
        toggleViewMode: vi.fn(),
        collapseToDefault: vi.fn(),
        isContextMenuOpen: false,
        closeContextMenu: vi.fn(),
    };
}

function createSearchBarStub() {
    return {
        focus: vi.fn().mockResolvedValue(undefined),
        loadActiveModel: vi.fn().mockResolvedValue(undefined),
        prefetchModelDropdownData: vi.fn().mockResolvedValue(undefined),
        invalidateModelDropdownData: vi.fn(),
        prepareModelDropdownOpen: vi.fn().mockResolvedValue(undefined),
        selectModelFromDropdown: vi.fn().mockResolvedValue({ modelId: 'gpt-5', providerId: 1 }),
        getModelDropdownAnchor: vi.fn(() => document.createElement('button')),
        getModelDropdownContext: vi.fn(() => ({
            activeModelId: 1,
            activeProviderId: 2,
            selectedModelId: 1,
            selectedProviderId: 2,
            models: [],
        })),
    };
}

function createConversationPanelStub() {
    return { focus: vi.fn() };
}

describe('when the user pins the search window on top', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        currentWindowMock.isAlwaysOnTop.mockResolvedValue(false);
        currentWindowMock.setAlwaysOnTop.mockResolvedValue(undefined);
    });

    it('user sees the pin state picked up from the window when the view opens', async () => {
        currentWindowMock.isAlwaysOnTop.mockResolvedValue(true);
        const mounted = await mountComposable(() => useSearchWindowPin());

        await expect(mounted.result.syncWindowPinState()).resolves.toBe(true);
        expect(mounted.result.isPinned.value).toBe(true);

        mounted.unmount();
    });

    it('user gets the window pinned on top when toggling the pin on', async () => {
        let pinned = false;
        currentWindowMock.isAlwaysOnTop.mockImplementation(async () => pinned);
        currentWindowMock.setAlwaysOnTop.mockImplementation(async (value: boolean) => {
            pinned = value;
        });
        const mounted = await mountComposable(() => useSearchWindowPin());
        await mounted.result.syncWindowPinState();

        await expect(mounted.result.toggleWindowPin()).resolves.toBe(true);

        expect(currentWindowMock.setAlwaysOnTop).toHaveBeenCalledWith(true);
        expect(mounted.result.isPinned.value).toBe(true);

        mounted.unmount();
    });

    it('user gets the window unpinned when toggling the pin off again', async () => {
        let pinned = true;
        currentWindowMock.isAlwaysOnTop.mockImplementation(async () => pinned);
        currentWindowMock.setAlwaysOnTop.mockImplementation(async (value: boolean) => {
            pinned = value;
        });
        const mounted = await mountComposable(() => useSearchWindowPin());
        await mounted.result.syncWindowPinState();

        await expect(mounted.result.toggleWindowPin()).resolves.toBe(false);

        expect(currentWindowMock.setAlwaysOnTop).toHaveBeenCalledWith(false);
        expect(mounted.result.isPinned.value).toBe(false);

        mounted.unmount();
    });

    it('user gets the requested pin state applied even if the window started elsewhere', async () => {
        const mounted = await mountComposable(() => useSearchWindowPin());

        currentWindowMock.isAlwaysOnTop.mockResolvedValue(true);
        await expect(mounted.result.setWindowPinned(true)).resolves.toBe(true);

        expect(currentWindowMock.setAlwaysOnTop).toHaveBeenCalledWith(true);

        mounted.unmount();
    });

    it('user gets rapid pin toggles applied in order instead of racing', async () => {
        let pinned = false;
        currentWindowMock.isAlwaysOnTop.mockImplementation(async () => pinned);
        currentWindowMock.setAlwaysOnTop.mockImplementation(async (value: boolean) => {
            pinned = value;
        });
        const mounted = await mountComposable(() => useSearchWindowPin());

        // Fire three toggles without awaiting: each must observe the previous result.
        const first = mounted.result.toggleWindowPin();
        const second = mounted.result.toggleWindowPin();
        const third = mounted.result.toggleWindowPin();
        await Promise.all([first, second, third]);

        expect(currentWindowMock.setAlwaysOnTop.mock.calls).toEqual([[true], [false], [true]]);
        expect(pinned).toBe(true);

        mounted.unmount();
    });
});

describe('when the user clicks a blank area of the quick search panel', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    function stubSelection(text: string) {
        vi.spyOn(window, 'getSelection').mockReturnValue({
            isCollapsed: text.length === 0,
            toString: () => text,
        } as unknown as Selection);
    }

    it('user gets the search input focused so they can keep typing', async () => {
        stubSelection('');
        const focusSearchInput = vi.fn().mockResolvedValue(undefined);
        const controller = { focusSearchInput } as unknown as SearchPageController;

        const mounted = await mountComposable(() => useSearchPanelFocusRestore({ controller }));

        mounted.result.handleQuickSearchBlankClick();

        expect(focusSearchInput).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets the focus kept while they are still selecting result text', async () => {
        stubSelection('copied file name');
        const focusSearchInput = vi.fn().mockResolvedValue(undefined);
        const controller = { focusSearchInput } as unknown as SearchPageController;

        const mounted = await mountComposable(() => useSearchPanelFocusRestore({ controller }));

        mounted.result.handleQuickSearchBlankClick();

        // Stealing focus mid-selection would clear the selection the user is dragging.
        expect(focusSearchInput).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets the focus restored once the selection is gone', async () => {
        stubSelection('');
        const focusSearchInput = vi.fn().mockResolvedValue(undefined);
        const controller = { focusSearchInput } as unknown as SearchPageController;

        const mounted = await mountComposable(() => useSearchPanelFocusRestore({ controller }));

        mounted.result.handleQuickSearchBlankClick();
        await nextTick();

        expect(focusSearchInput).toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the page asks its panels to do something', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    it('user gets the search input focused when the page asks for it', async () => {
        const searchBar = createSearchBarStub();
        const controller = useSearchPageController({
            searchBar: ref(searchBar as never),
            quickSearchOpen: ref(false),
            quickSearchPanel: ref(createQuickSearchPanelStub() as never),
            conversationPanel: ref(createConversationPanelStub() as never),
        });

        await controller.focusSearchInput();

        expect(searchBar.focus).toHaveBeenCalled();
    });

    it('user gets the active model reloaded after switching conversations', async () => {
        const searchBar = createSearchBarStub();
        const controller = useSearchPageController({
            searchBar: ref(searchBar as never),
            quickSearchOpen: ref(false),
            quickSearchPanel: ref(createQuickSearchPanelStub() as never),
            conversationPanel: ref(createConversationPanelStub() as never),
        });

        await controller.loadActiveModel();

        expect(searchBar.loadActiveModel).toHaveBeenCalled();
    });

    it('user gets the conversation panel focused when moving into the transcript', () => {
        const conversationPanel = createConversationPanelStub();
        const controller = useSearchPageController({
            searchBar: ref(createSearchBarStub() as never),
            quickSearchOpen: ref(false),
            quickSearchPanel: ref(createQuickSearchPanelStub() as never),
            conversationPanel: ref(conversationPanel as never),
        });

        controller.focusConversation();

        expect(conversationPanel.focus).toHaveBeenCalled();
    });

    it('user gets the panel opened and closed through the page controller', () => {
        const quickSearchPanel = createQuickSearchPanelStub();
        const quickSearchOpen = ref(false);
        const controller = useSearchPageController({
            searchBar: ref(createSearchBarStub() as never),
            quickSearchOpen,
            quickSearchPanel: ref(quickSearchPanel as never),
            conversationPanel: ref(createConversationPanelStub() as never),
        });

        controller.openQuickSearch();
        expect(quickSearchPanel.open).toHaveBeenCalled();

        controller.closeQuickSearch();
        expect(quickSearchPanel.close).toHaveBeenCalled();

        controller.moveQuickSearchSelection('down');
        expect(quickSearchPanel.moveSelection).toHaveBeenCalledWith('down');

        controller.triggerQuickSearch('touch');
        expect(quickSearchPanel.triggerSearch).toHaveBeenCalledWith('touch');

        controller.goToNextPageQuickSearch();
        expect(quickSearchPanel.goToNextPage).toHaveBeenCalled();

        controller.goToPreviousPageQuickSearch();
        expect(quickSearchPanel.goToPreviousPage).toHaveBeenCalled();

        controller.toggleQuickSearchView();
        expect(quickSearchPanel.toggleViewMode).toHaveBeenCalled();

        controller.openQuickSearchContextMenu();
        expect(quickSearchPanel.openContextMenuForHighlightedItem).toHaveBeenCalled();

        controller.goToPageQuickSearch(2);
        expect(quickSearchPanel.goToPage).toHaveBeenCalledWith(2);
    });

    it('user gets the highlight state reported so the keyboard can tell whether Enter opens an item', () => {
        const quickSearchPanel = createQuickSearchPanelStub();
        quickSearchPanel.getHighlightedItem.mockReturnValue({ name: 'TouchAI' });
        const controller = useSearchPageController({
            searchBar: ref(createSearchBarStub() as never),
            quickSearchOpen: ref(false),
            quickSearchPanel: ref(quickSearchPanel as never),
            conversationPanel: ref(createConversationPanelStub() as never),
        });

        expect(controller.isQuickSearchItemHighlighted()).toBe(true);
    });

    it('user gets no highlight reported when nothing is selected in the panel', () => {
        const controller = useSearchPageController({
            searchBar: ref(createSearchBarStub() as never),
            quickSearchOpen: ref(false),
            quickSearchPanel: ref(createQuickSearchPanelStub() as never),
            conversationPanel: ref(createConversationPanelStub() as never),
        });

        expect(controller.isQuickSearchItemHighlighted()).toBe(false);
    });

    it('user gets the focus back in the input after collapsing the panel', async () => {
        const quickSearchPanel = createQuickSearchPanelStub();
        const searchBar = createSearchBarStub();
        const controller = useSearchPageController({
            searchBar: ref(searchBar as never),
            quickSearchOpen: ref(true),
            quickSearchPanel: ref(quickSearchPanel as never),
            conversationPanel: ref(createConversationPanelStub() as never),
        });

        controller.collapseQuickSearch();
        await nextTick();

        expect(quickSearchPanel.collapseToDefault).toHaveBeenCalled();
        expect(searchBar.focus).toHaveBeenCalled();
    });

    it('user gets the focus back in the input after closing the result context menu', async () => {
        const quickSearchPanel = createQuickSearchPanelStub();
        const searchBar = createSearchBarStub();
        const controller = useSearchPageController({
            searchBar: ref(searchBar as never),
            quickSearchOpen: ref(true),
            quickSearchPanel: ref(quickSearchPanel as never),
            conversationPanel: ref(createConversationPanelStub() as never),
        });

        controller.closeQuickSearchContextMenu();
        await nextTick();

        expect(quickSearchPanel.closeContextMenu).toHaveBeenCalled();
        expect(searchBar.focus).toHaveBeenCalled();
    });

    it('user gets the dropdown context and anchor from the search bar', async () => {
        const searchBar = createSearchBarStub();
        const controller = useSearchPageController({
            searchBar: ref(searchBar as never),
            quickSearchOpen: ref(false),
            quickSearchPanel: ref(createQuickSearchPanelStub() as never),
            conversationPanel: ref(createConversationPanelStub() as never),
        });

        expect(controller.getModelDropdownAnchor()).toBeInstanceOf(HTMLElement);
        expect(controller.getModelDropdownContext()).toMatchObject({
            activeModelId: 1,
            selectedProviderId: 2,
        });

        await controller.prepareModelDropdownOpen();
        expect(searchBar.prepareModelDropdownOpen).toHaveBeenCalled();

        await controller.prefetchModelDropdownData();
        expect(searchBar.prefetchModelDropdownData).toHaveBeenCalled();

        controller.invalidateModelDropdownData();
        expect(searchBar.invalidateModelDropdownData).toHaveBeenCalled();

        await expect(controller.selectModelFromDropdown(7)).resolves.toEqual({
            modelId: 'gpt-5',
            providerId: 1,
        });
    });

    it('user gets safe defaults when the search bar is not mounted yet', async () => {
        const controller = useSearchPageController({
            searchBar: ref(undefined),
            quickSearchOpen: ref(false),
            quickSearchPanel: ref(undefined),
            conversationPanel: ref(undefined),
        });

        expect(controller.getModelDropdownAnchor()).toBeNull();
        expect(controller.getModelDropdownContext()).toEqual({
            activeModelId: null,
            activeProviderId: null,
            selectedModelId: null,
            selectedProviderId: null,
            models: [],
        });
        await expect(controller.selectModelFromDropdown(1)).resolves.toEqual({
            modelId: null,
            providerId: null,
        });
        expect(controller.isQuickSearchContextMenuOpen()).toBe(false);
        expect(() => controller.focusConversation()).not.toThrow();
    });
});

describe('when the user clicks around the search window', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    function mountKeyboard(overrides: Record<string, unknown> = {}) {
        const controller = {
            ...createQuickSearchPanelStub(),
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
            isQuickSearchContextMenuOpen: vi.fn(() => false),
            closeQuickSearchContextMenu: vi.fn(),
        };
        const hideAllPopups = vi.fn().mockResolvedValue(undefined);
        const hideSearchWindow = vi.fn().mockResolvedValue(undefined);

        return mountComposable(() =>
            useSearchKeyboard({
                viewReady: ref(true),
                searchKeybindings: ref({
                    'search.history.open': null,
                    'search.input.focus': null,
                    'search.session.new': null,
                    'search.session.reopenLastClosed': null,
                    'search.model.toggle': null,
                    'search.quickSearch.toggleView': null,
                    'search.window.pin': null,
                    'search.window.maximize': null,
                    'search.settings.open': null,
                }),
                queryText: ref(''),
                attachments: ref([]),
                cursorContext: ref<SearchCursorContext>({
                    isMultiLine: false,
                    cursorAtStart: true,
                    cursorAtTextStart: true,
                    cursorAtEnd: true,
                }),
                modelOverride: ref<SearchModelOverride>({ modelId: null, providerId: null }),
                modelDropdownState: ref({ isOpen: false }),
                controller: controller as never,
                sessionHistory: ref([]),
                hasPendingRequest: () => false,
                isLoading: ref(false),
                pendingToolApproval: ref(null),
                approvePendingToolApproval: vi.fn(() => false),
                rejectPendingToolApproval: vi.fn(() => false),
                promptPendingToolApprovalAttention: vi.fn(),
                getActivePopupType: () => null,
                hasActivePopupWindowFocus: () => false,
                isQuickSearchOpen: ref(false) as never,
                shouldTriggerQuickSearch: () => false,
                sessionHistoryPopupOpen: ref(false),
                hideAllPopups,
                hideSearchWindow,
                navigateInputHistory: vi.fn(() => 'ignored' as const),
                closeModelDropdown: vi.fn().mockResolvedValue(undefined),
                handleSearchKeybindingAction: vi.fn().mockResolvedValue(undefined),
                handleSubmit: vi.fn().mockResolvedValue(undefined),
                cancelRequest: vi.fn(),
                cancelPendingRequest: vi.fn(() => false),
                clearSession: vi.fn(),
                ...overrides,
            })
        ).then((mounted) => ({ ...mounted, controller, hideAllPopups, hideSearchWindow }));
    }

    it('user gets the window hidden when clicking the empty area outside the search bar', async () => {
        const { hideSearchWindow, unmount } = await mountKeyboard();

        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await nextTick();

        expect(hideSearchWindow).toHaveBeenCalled();

        unmount();
    });

    it('user gets popups dismissed when clicking elsewhere in the window', async () => {
        const { hideAllPopups, unmount } = await mountKeyboard({
            modelDropdownState: ref({ isOpen: true }),
        });

        const inner = document.createElement('div');
        document.body.appendChild(inner);
        inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        expect(hideAllPopups).toHaveBeenCalled();

        unmount();
    });

    it('user keeps the popup open when clicking the logo or the history trigger', async () => {
        const { hideAllPopups, unmount } = await mountKeyboard({
            modelDropdownState: ref({ isOpen: true }),
        });

        const logo = document.createElement('div');
        logo.className = 'logo-container';
        document.body.appendChild(logo);
        logo.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        expect(hideAllPopups).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets the key listener released when leaving the search view', async () => {
        const { unmount } = await mountKeyboard();
        const removeSpy = vi.spyOn(window, 'removeEventListener');

        unmount();

        expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    });
});
