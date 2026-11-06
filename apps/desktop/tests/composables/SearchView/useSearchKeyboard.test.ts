import { mountComposable } from '@tests/utils/composables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';

import { createDefaultSearchKeybindings } from '@/config/searchKeybindings';
import type { PendingToolApproval, SessionMessage } from '@/types/session';
import type { UseSearchKeyboardOptions } from '@/views/SearchView/composables/searchInteraction';
import { useSearchKeyboard } from '@/views/SearchView/composables/useSearchPage';
import type { PendingRequest, SearchPageController } from '@/views/SearchView/types';

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
        openQuickSearch: vi.fn(),
        closeQuickSearch: vi.fn(),
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
        isWaitingForCompletion: ref(false),
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
