import { mountComposable } from '@tests/utils/composables';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, type Ref, ref } from 'vue';

import { createDefaultSearchKeybindings } from '@/config/searchKeybindings';
import { createInputHistorySnapshot, type SessionMessage } from '@/types/session';
import {
    createPopupSurfaceCoordinator,
    createSearchEntryPolicy,
    createSearchInteractionContext,
    createSearchKeydownHandler,
    createSessionInputHistoryBrowseState,
    extractSessionInputHistoryEntries,
    navigateSessionInputHistory,
    useQuickSearchCoordinator,
    useSearchOverlayMachine,
} from '@/views/SearchView/composables/searchInteraction';
import type {
    SearchCursorContext,
    SearchModelOverride,
    SearchPageController,
} from '@/views/SearchView/types';

function createUserMessage(id: string, overrides: Partial<SessionMessage> = {}): SessionMessage {
    return {
        id,
        role: 'user',
        content: '',
        parts: [],
        timestamp: Number(id),
        ...overrides,
    };
}

function createAttachment(id: string) {
    return {
        id,
        type: 'file' as const,
        path: `D:/${id}.txt`,
        originPath: `D:/${id}.txt`,
        name: `${id}.txt`,
    };
}

beforeEach(() => {
    setActivePinia(createPinia());
});

function createControllerStub() {
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
    } satisfies SearchPageController;
}

function createSearchKeydownHandlerForTest(
    overrides: Partial<Parameters<typeof createSearchKeydownHandler>[0]> = {}
) {
    const controller = createControllerStub();
    return createSearchKeydownHandler({
        viewReady: ref(true),
        searchKeybindings: ref(createDefaultSearchKeybindings()),
        queryText: ref(''),
        attachments: ref([]),
        cursorContext: ref<SearchCursorContext>({
            isMultiLine: false,
            cursorAtStart: true,
            cursorAtTextStart: true,
            cursorAtEnd: true,
        }),
        modelOverride: ref<SearchModelOverride>({
            modelId: null,
            providerId: null,
        }),
        modelDropdownState: ref({ isOpen: false }),
        controller,
        sessionHistory: ref([]),
        hasPendingRequest: () => false,
        isLoading: ref(false),
        pendingToolApproval: ref(null),
        approvePendingToolApproval: vi.fn(() => false),
        rejectPendingToolApproval: vi.fn(() => false),
        promptPendingToolApprovalAttention: vi.fn(),
        getActivePopupType: () => null,
        hasActivePopupWindowFocus: () => false,
        isQuickSearchOpen: computed(() => false),
        shouldTriggerQuickSearch: () => false,
        sessionHistoryPopupOpen: ref(false),
        hideAllPopups: vi.fn().mockResolvedValue(undefined),
        hideSearchWindow: vi.fn().mockResolvedValue(undefined),
        navigateInputHistory: vi.fn(() => 'ignored' as const),
        closeModelDropdown: vi.fn().mockResolvedValue(undefined),
        handleSearchKeybindingAction: vi.fn().mockResolvedValue(undefined),
        handleSubmit: vi.fn().mockResolvedValue(undefined),
        cancelRequest: vi.fn(),
        cancelPendingRequest: vi.fn(() => false),
        clearSession: vi.fn(),
        ...overrides,
    });
}

async function flushKeyboardWork() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('when the user browses the prompts they already sent', () => {
    it('user only sees prompts that still carry visible input', () => {
        const entries = extractSessionInputHistoryEntries([
            createUserMessage('1', { content: 'fallback text' }),
            // Explicitly excluded from history by the caller.
            createUserMessage('2', {
                inputSnapshot: createInputHistorySnapshot({
                    text: '',
                    attachments: [],
                    excludeFromHistory: true,
                }),
            }),
            {
                id: '3',
                role: 'assistant',
                content: 'assistant reply',
                parts: [],
                timestamp: 3,
            },
            // Empty text but still meaningful because of the attachment.
            createUserMessage('4', {
                inputSnapshot: createInputHistorySnapshot({
                    text: '',
                    attachments: [createAttachment('attachment-1')],
                }),
            }),
        ]);

        expect(entries).toEqual([
            createInputHistorySnapshot({ text: 'fallback text', attachments: [] }),
            createInputHistorySnapshot({
                text: '',
                attachments: [createAttachment('attachment-1')],
            }),
        ]);
    });

    it('user gets the draft captured when stepping back from the newest position', () => {
        const latestDraft = createInputHistorySnapshot({ text: 'draft', attachments: [] });
        const entries = [
            createInputHistorySnapshot({ text: 'first', attachments: [] }),
            createInputHistorySnapshot({ text: 'second', attachments: [] }),
        ];

        const result = navigateSessionInputHistory({
            entries,
            currentDraft: latestDraft,
            direction: 'older',
            state: createSessionInputHistoryBrowseState(entries.length),
        });

        expect(result.changed).toBe(true);
        expect(result.nextSnapshot).toEqual(entries[1]);
        expect(result.state).toEqual({
            pointer: 1,
            draftBeforeBrowse: latestDraft,
            activeBrowseSnapshot: entries[1],
        });
    });

    it('user gets their draft back when stepping forward to the newest position', () => {
        const restoredDraft = createInputHistorySnapshot({
            text: 'draft before browse',
            attachments: [],
        });
        const firstEntry = createInputHistorySnapshot({ text: 'first', attachments: [] });
        const secondEntry = createInputHistorySnapshot({ text: 'second', attachments: [] });
        const entries = [firstEntry, secondEntry];

        const result = navigateSessionInputHistory({
            entries,
            currentDraft: createInputHistorySnapshot({ text: 'ignored', attachments: [] }),
            direction: 'newer',
            state: {
                pointer: 1,
                draftBeforeBrowse: restoredDraft,
                activeBrowseSnapshot: secondEntry,
            },
        });

        expect(result.changed).toBe(true);
        expect(result.nextSnapshot).toEqual(restoredDraft);
        expect(result.state).toEqual({
            pointer: 2,
            draftBeforeBrowse: restoredDraft,
            activeBrowseSnapshot: null,
        });
    });

    it('user gets nothing to browse when the conversation has no prompts yet', () => {
        const currentDraft = createInputHistorySnapshot({ text: 'draft', attachments: [] });

        const result = navigateSessionInputHistory({
            entries: [],
            currentDraft,
            direction: 'older',
            state: createSessionInputHistoryBrowseState(0),
        });

        expect(result.changed).toBe(false);
        expect(result.nextSnapshot).toEqual(currentDraft);
        expect(result.state.pointer).toBe(0);
    });

    it('user stays on the oldest prompt when pressing back again', () => {
        const entries = [
            createInputHistorySnapshot({ text: 'first', attachments: [] }),
            createInputHistorySnapshot({ text: 'second', attachments: [] }),
        ];

        const result = navigateSessionInputHistory({
            entries,
            currentDraft: createInputHistorySnapshot({ text: 'draft', attachments: [] }),
            direction: 'older',
            state: {
                pointer: 0,
                draftBeforeBrowse: createInputHistorySnapshot({ text: 'draft', attachments: [] }),
                activeBrowseSnapshot: entries[0]!,
            },
        });

        expect(result.changed).toBe(false);
        expect(result.nextSnapshot).toEqual(entries[0]);
        expect(result.state.pointer).toBe(0);
    });

    it('user stays on the newest position when pressing forward at the end', () => {
        const currentDraft = createInputHistorySnapshot({ text: 'draft', attachments: [] });
        const entries = [createInputHistorySnapshot({ text: 'first', attachments: [] })];

        const result = navigateSessionInputHistory({
            entries,
            currentDraft,
            direction: 'newer',
            state: createSessionInputHistoryBrowseState(entries.length),
        });

        expect(result.changed).toBe(false);
        expect(result.nextSnapshot).toEqual(currentDraft);
        expect(result.state.activeBrowseSnapshot).toBeNull();
    });

    it('user walks from the oldest prompt forward to the next one', () => {
        const entries = [
            createInputHistorySnapshot({ text: 'first', attachments: [] }),
            createInputHistorySnapshot({ text: 'second', attachments: [] }),
            createInputHistorySnapshot({ text: 'third', attachments: [] }),
        ];

        const result = navigateSessionInputHistory({
            entries,
            currentDraft: createInputHistorySnapshot({ text: 'draft', attachments: [] }),
            direction: 'newer',
            state: {
                pointer: 0,
                draftBeforeBrowse: createInputHistorySnapshot({ text: 'draft', attachments: [] }),
                activeBrowseSnapshot: entries[0]!,
            },
        });

        expect(result.changed).toBe(true);
        expect(result.nextSnapshot).toEqual(entries[1]);
        expect(result.state.pointer).toBe(1);
    });
});

describe('when a shortcut opens the search window', () => {
    it('user gets the entry checked once per appearance and each snapshot consumed once', () => {
        const policy = createSearchEntryPolicy();

        expect(
            policy.shouldCheckShortcutEntry({
                activationSource: 'shortcut',
                visibilityEpoch: 3,
                entryCheckArmedVisibilityEpoch: 3,
                lastEntryCheckedVisibilityEpoch: null,
            })
        ).toBe(true);

        expect(policy.shouldConsumeSnapshot('snapshot-1')).toBe(true);
        policy.markSnapshotConsumed('snapshot-1');
        expect(policy.shouldConsumeSnapshot('snapshot-1')).toBe(false);

        expect(
            policy.shouldCheckShortcutEntry({
                activationSource: 'shortcut',
                visibilityEpoch: 3,
                entryCheckArmedVisibilityEpoch: 3,
                lastEntryCheckedVisibilityEpoch: 3,
            })
        ).toBe(false);
    });

    it('user does not get the entry checked when the window was opened another way', () => {
        const policy = createSearchEntryPolicy();

        expect(
            policy.shouldCheckShortcutEntry({
                activationSource: 'manual',
                visibilityEpoch: 3,
                entryCheckArmedVisibilityEpoch: 3,
                lastEntryCheckedVisibilityEpoch: null,
            })
        ).toBe(false);
    });

    it('user gets no snapshot consumed when there is no snapshot to consume', () => {
        const policy = createSearchEntryPolicy();

        expect(policy.shouldConsumeSnapshot(null)).toBe(false);
        expect(policy.shouldConsumeSnapshot('')).toBe(false);
        expect(() => policy.markSnapshotConsumed(null)).not.toThrow();
    });
});

describe('when a popup window talks to the search window', () => {
    it('user only gets events from the popup session that is actually on screen', () => {
        const interactionContext = createSearchInteractionContext();
        const coordinator = createPopupSurfaceCoordinator(interactionContext);

        coordinator.activatePopup({
            popupId: 'popup-model-dropdown-popup:2',
            popupType: 'model-dropdown-surface',
            windowLabel: 'popup-model-dropdown-popup',
            popupSessionVersion: 2,
        });

        expect(
            coordinator.isCurrentPopupEvent({
                popupId: 'popup-model-dropdown-popup:2',
                windowLabel: 'popup-model-dropdown-popup',
                popupSessionVersion: 2,
            })
        ).toBe(true);

        // A reopened popup keeps the id but bumps the version.
        expect(
            coordinator.isCurrentPopupEvent({
                popupId: 'popup-model-dropdown-popup:2',
                windowLabel: 'popup-model-dropdown-popup',
                popupSessionVersion: 3,
            })
        ).toBe(false);

        coordinator.clearActivePopup();

        expect(
            coordinator.isCurrentPopupEvent({
                popupId: 'popup-model-dropdown-popup:2',
                windowLabel: 'popup-model-dropdown-popup',
                popupSessionVersion: 2,
            })
        ).toBe(false);
    });

    it('user gets no popup event accepted when no popup was ever activated', () => {
        const coordinator = createPopupSurfaceCoordinator(createSearchInteractionContext());

        expect(
            coordinator.isCurrentPopupEvent({
                popupId: 'popup-session-history-popup:1',
                windowLabel: 'popup-session-history-popup',
                popupSessionVersion: 1,
            })
        ).toBe(false);
    });
});

describe('when the search window tracks its own visibility', () => {
    it('user gets the hide reason and epoch recorded when the window hides', () => {
        const context = createSearchInteractionContext();

        context.recordActivation('shortcut');
        expect(context.state.activationSource).toBe('shortcut');

        context.markWindowHidden({ hideReason: 'manual-dismiss', hiddenAt: 1234 });

        expect(context.state.windowVisible).toBe(false);
        expect(context.state.windowFocused).toBe(false);
        expect(context.state.lastHideReason).toBe('manual-dismiss');
        expect(context.state.lastHideAt).toBe(1234);
        expect(context.state.activationSource).toBe('unknown');
        // The next shortcut entry must be armed for the new visibility epoch.
        expect(context.state.entryCheckArmedVisibilityEpoch).toBe(context.state.visibilityEpoch);
    });

    it('user gets a timeout clear only once per hidden epoch', () => {
        const context = createSearchInteractionContext();
        context.markWindowHidden({ hideReason: 'manual-dismiss', hiddenAt: 1_000 });

        expect(
            context.shouldRunTimeoutClearOnFocus(
                context.state.visibilityEpoch,
                1_000 + 5_000,
                1_000
            )
        ).toBe(true);

        // The same epoch cannot trigger the clear twice.
        expect(
            context.shouldRunTimeoutClearOnFocus(
                context.state.visibilityEpoch,
                1_000 + 6_000,
                1_000
            )
        ).toBe(false);
    });

    it('user gets no timeout clear when the window comes back too soon', () => {
        const context = createSearchInteractionContext();
        context.markWindowHidden({ hideReason: 'manual-dismiss', hiddenAt: 1_000 });

        expect(
            context.shouldRunTimeoutClearOnFocus(context.state.visibilityEpoch, 1_500, 5_000)
        ).toBe(false);
    });

    it('user gets no timeout clear for a stale visibility epoch', () => {
        const context = createSearchInteractionContext();
        context.markWindowHidden({ hideReason: 'manual-dismiss', hiddenAt: 1_000 });
        const staleEpoch = context.state.visibilityEpoch;
        context.markWindowHidden({ hideReason: 'manual-dismiss', hiddenAt: 2_000 });

        expect(context.shouldRunTimeoutClearOnFocus(staleEpoch, 9_000, 0)).toBe(false);
    });
});

describe('when the user types a query that could show the quick search panel', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    async function mountCoordinator(queryText: Ref<string>) {
        const controller = createControllerStub();
        const attachments = ref<unknown[]>([]);
        const sessionHistory = ref<SessionMessage[]>([]);
        const cursorContext = ref<SearchCursorContext>({
            isMultiLine: false,
            cursorAtStart: true,
            cursorAtTextStart: true,
            cursorAtEnd: true,
        });
        const modelOverride = ref<SearchModelOverride>({ modelId: null, providerId: null });
        const modelDropdownState = ref({ isOpen: false });
        const quickSearchOpen = ref(false);

        const mounted = await mountComposable(() =>
            useQuickSearchCoordinator({
                queryText,
                attachments,
                sessionHistory,
                cursorContext,
                modelOverride,
                modelDropdownState,
                quickSearchOpen,
                controller,
            })
        );

        return {
            ...mounted,
            controller,
            attachments,
            sessionHistory,
            cursorContext,
            modelOverride,
            modelDropdownState,
        };
    }

    it('user sees the panel appear for a plain query with nothing in the way', async () => {
        const { result, controller, unmount } = await mountCoordinator(ref('touchai'));

        result.syncQuickSearchPanel();

        expect(controller.triggerQuickSearch).toHaveBeenCalledWith('touchai');

        unmount();
    });

    it('user does not get the panel once an attachment is added', async () => {
        const { result, controller, attachments, unmount } = await mountCoordinator(ref('touchai'));

        result.syncQuickSearchPanel();
        attachments.value = [createAttachment('blocker')];
        await nextTick();

        expect(controller.closeQuickSearch).toHaveBeenCalled();

        unmount();
    });

    it('user does not get the panel while the model dropdown is open', async () => {
        const { result, modelDropdownState, unmount } = await mountCoordinator(ref('touchai'));

        modelDropdownState.value = { isOpen: true };

        expect(result.shouldTriggerQuickSearch('touchai')).toBe(false);

        unmount();
    });

    it('user does not get the panel when the draft is multiline', async () => {
        const { result, cursorContext, unmount } = await mountCoordinator(ref('touchai'));

        cursorContext.value = {
            isMultiLine: true,
            cursorAtStart: true,
            cursorAtTextStart: true,
            cursorAtEnd: true,
        };

        expect(result.shouldTriggerQuickSearch('touchai')).toBe(false);

        unmount();
    });

    it('user does not get the panel when a model was picked by hand', async () => {
        const { result, modelOverride, unmount } = await mountCoordinator(ref('touchai'));

        modelOverride.value = { modelId: 'gpt-5', providerId: 1 };

        expect(result.shouldTriggerQuickSearch('touchai')).toBe(false);

        unmount();
    });

    it('user does not get the panel once the conversation has started', async () => {
        const { result, sessionHistory, unmount } = await mountCoordinator(ref('touchai'));

        sessionHistory.value = [createUserMessage('1', { content: 'hello' })];

        expect(result.shouldTriggerQuickSearch('touchai')).toBe(false);

        unmount();
    });

    it('user does not get the panel for a blank query', async () => {
        const { result, unmount } = await mountCoordinator(ref('   '));

        expect(result.shouldTriggerQuickSearch('   ')).toBe(false);

        unmount();
    });

    it('user gets the panel closed instead of reopened while a layout change is settling', async () => {
        const suppressNextAutoOpen = ref(true);

        const controller = createControllerStub();
        const mounted = await mountComposable(() =>
            useQuickSearchCoordinator({
                queryText: ref('touchai'),
                attachments: ref([]),
                sessionHistory: ref([]),
                cursorContext: ref<SearchCursorContext>({
                    isMultiLine: false,
                    cursorAtStart: true,
                    cursorAtTextStart: true,
                    cursorAtEnd: true,
                }),
                modelOverride: ref<SearchModelOverride>({ modelId: null, providerId: null }),
                modelDropdownState: ref({ isOpen: false }),
                quickSearchOpen: ref(false),
                controller,
                suppressNextAutoOpen,
            })
        );

        mounted.result.syncQuickSearchPanel();

        expect(controller.closeQuickSearch).toHaveBeenCalled();
        expect(controller.triggerQuickSearch).not.toHaveBeenCalled();
        // The suppression is one-shot: the next sync behaves normally again.
        expect(suppressNextAutoOpen.value).toBe(false);

        mounted.unmount();
    });
});

describe('when a search shortcut arrives from the host window', () => {
    it('user gets the shortcut action run through the same keyboard guards', async () => {
        const handleSearchKeybindingAction = vi.fn().mockResolvedValue(undefined);
        const handleKeyDown = createSearchKeydownHandlerForTest({ handleSearchKeybindingAction });

        expect(
            handleKeyDown.routeSearchSurfaceCommand({
                actionId: 'search.model.toggle',
                shortcut: 'Mod+M',
                source: 'webview2-accelerator',
            })
        ).toBe(true);
        await flushKeyboardWork();

        expect(handleSearchKeybindingAction).toHaveBeenCalledWith('search.model.toggle');
    });

    it('user gets the shortcut ignored while the quick search context menu is open', async () => {
        const controller = createControllerStub();
        controller.isQuickSearchContextMenuOpen.mockReturnValue(true);
        const handleSearchKeybindingAction = vi.fn().mockResolvedValue(undefined);
        const handleKeyDown = createSearchKeydownHandlerForTest({
            controller,
            handleSearchKeybindingAction,
        });

        expect(
            handleKeyDown.routeSearchSurfaceCommand({
                actionId: 'search.model.toggle',
                shortcut: 'Mod+M',
                source: 'webview2-accelerator',
            })
        ).toBe(false);
        await flushKeyboardWork();

        expect(handleSearchKeybindingAction).not.toHaveBeenCalled();
    });

    it('user gets the shortcut ignored while the view is still starting up', async () => {
        const handleSearchKeybindingAction = vi.fn().mockResolvedValue(undefined);
        const handleKeyDown = createSearchKeydownHandlerForTest({
            viewReady: ref(false),
            handleSearchKeybindingAction,
        });

        expect(
            handleKeyDown.routeSearchSurfaceCommand({
                actionId: 'search.model.toggle',
                shortcut: 'Mod+M',
                source: 'webview2-accelerator',
            })
        ).toBe(false);

        expect(handleSearchKeybindingAction).not.toHaveBeenCalled();
    });
});

describe('when the user presses keys on the search surface', () => {
    it('user gets the maximize shortcut triggered by F11', async () => {
        const handleSearchKeybindingAction = vi.fn().mockResolvedValue(undefined);
        const handleKeyDown = createSearchKeydownHandlerForTest({ handleSearchKeybindingAction });

        const event = new KeyboardEvent('keydown', { key: 'F11', cancelable: true });
        await handleKeyDown(event);
        await flushKeyboardWork();

        expect(handleSearchKeybindingAction).toHaveBeenCalledWith('search.window.maximize');
        expect(event.defaultPrevented).toBe(true);
    });

    it('user gets the reopen shortcut triggered by the configured key', async () => {
        const handleSearchKeybindingAction = vi.fn().mockResolvedValue(undefined);
        const handleKeyDown = createSearchKeydownHandlerForTest({
            searchKeybindings: ref({
                ...createDefaultSearchKeybindings(),
                'search.session.reopenLastClosed': 'Mod+Shift+Y',
            }),
            handleSearchKeybindingAction,
        });

        const event = new KeyboardEvent('keydown', {
            key: 'y',
            ctrlKey: true,
            shiftKey: true,
            cancelable: true,
        });
        await handleKeyDown(event);
        await flushKeyboardWork();

        expect(handleSearchKeybindingAction).toHaveBeenCalledWith(
            'search.session.reopenLastClosed'
        );
        expect(event.defaultPrevented).toBe(true);
    });

    it('user gets the running request cancelled by Escape', async () => {
        const cancelRequest = vi.fn();
        const handleKeyDown = createSearchKeydownHandlerForTest({
            isLoading: ref(true),
            cancelRequest,
        });

        const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
        await handleKeyDown(event);

        expect(cancelRequest).toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
    });

    it('user gets the running request cancelled by pressing Backspace twice quickly', async () => {
        const cancelPendingRequest = vi.fn(() => true);
        const handleKeyDown = createSearchKeydownHandlerForTest({
            hasPendingRequest: () => true,
            cancelPendingRequest,
        });

        const firstBackspaceEvent = new KeyboardEvent('keydown', {
            key: 'Backspace',
            cancelable: true,
        });
        await handleKeyDown(firstBackspaceEvent);
        expect(cancelPendingRequest).not.toHaveBeenCalled();
        expect(firstBackspaceEvent.defaultPrevented).toBe(false);

        const secondBackspaceEvent = new KeyboardEvent('keydown', {
            key: 'Backspace',
            cancelable: true,
        });
        await handleKeyDown(secondBackspaceEvent);
        expect(cancelPendingRequest).toHaveBeenCalledTimes(1);
        expect(secondBackspaceEvent.defaultPrevented).toBe(true);
    });

    it('user does not lose the request when the second Backspace comes long after the first', async () => {
        const cancelPendingRequest = vi.fn(() => true);
        const handleKeyDown = createSearchKeydownHandlerForTest({
            hasPendingRequest: () => true,
            cancelPendingRequest,
        });
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);

        await handleKeyDown(new KeyboardEvent('keydown', { key: 'Backspace', cancelable: true }));

        nowSpy.mockReturnValue(1_000 + 1_000);
        const lateEvent = new KeyboardEvent('keydown', { key: 'Backspace', cancelable: true });
        await handleKeyDown(lateEvent);

        expect(cancelPendingRequest).not.toHaveBeenCalled();
        expect(lateEvent.defaultPrevented).toBe(false);
        nowSpy.mockRestore();
    });

    it('user gets the model dropdown closed with Backspace before anything else happens', async () => {
        const closeModelDropdown = vi.fn().mockResolvedValue(undefined);
        const handleKeyDown = createSearchKeydownHandlerForTest({
            modelDropdownState: ref({ isOpen: true }),
            closeModelDropdown,
        });

        await handleKeyDown(new KeyboardEvent('keydown', { key: 'Backspace', cancelable: true }));

        expect(closeModelDropdown).toHaveBeenCalled();
    });

    it('user gets the hand-picked model dropped by Backspace at the start of an empty draft', async () => {
        const modelOverride = ref<SearchModelOverride>({ modelId: 'gpt-5', providerId: 1 });
        const handleKeyDown = createSearchKeydownHandlerForTest({ modelOverride });

        const event = new KeyboardEvent('keydown', { key: 'Backspace', cancelable: true });
        await handleKeyDown(event);

        expect(modelOverride.value).toEqual({ modelId: null, providerId: null });
        expect(event.defaultPrevented).toBe(true);
    });

    it('user gets the conversation focused with Tab when a conversation is on screen', async () => {
        const controller = createControllerStub();
        const handleKeyDown = createSearchKeydownHandlerForTest({
            controller,
            sessionHistory: ref([createUserMessage('1', { content: 'hello' })]),
        });

        const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
        await handleKeyDown(event);

        expect(controller.focusConversation).toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
    });

    it('user gets Escape to close the quick search context menu', async () => {
        const controller = createControllerStub();
        controller.isQuickSearchContextMenuOpen.mockReturnValue(true);
        const handleKeyDown = createSearchKeydownHandlerForTest({ controller });

        const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
        await handleKeyDown(event);

        expect(controller.closeQuickSearchContextMenu).toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
    });

    it('user gets other keys left alone while the context menu is open so the menu can navigate', async () => {
        const controller = createControllerStub();
        controller.isQuickSearchContextMenuOpen.mockReturnValue(true);
        const handleKeyDown = createSearchKeydownHandlerForTest({ controller });

        const event = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
        await handleKeyDown(event);

        expect(controller.closeQuickSearchContextMenu).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    it('user gets no search handling while the view is not ready yet', async () => {
        const handleSearchKeybindingAction = vi.fn().mockResolvedValue(undefined);
        const handleKeyDown = createSearchKeydownHandlerForTest({
            viewReady: ref(false),
            handleSearchKeybindingAction,
        });

        const event = new KeyboardEvent('keydown', { key: 'F11', cancelable: true });
        await handleKeyDown(event);

        expect(handleSearchKeybindingAction).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    it('user gets no double handling when another handler already took the key', async () => {
        const handleSearchKeybindingAction = vi.fn().mockResolvedValue(undefined);
        const handleKeyDown = createSearchKeydownHandlerForTest({ handleSearchKeybindingAction });

        const event = new KeyboardEvent('keydown', { key: 'F11', cancelable: true });
        event.preventDefault();
        await handleKeyDown(event);
        await flushKeyboardWork();

        expect(handleSearchKeybindingAction).not.toHaveBeenCalled();
    });
});

describe('when the model dropdown and quick search overlap', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user gets the dropdown opening only after the quick search panel has closed', async () => {
        const quickSearchOpen = ref(true);
        const modelDropdownState = ref({ isOpen: false });

        const mounted = await mountComposable(() =>
            useSearchOverlayMachine({
                isQuickSearchOpen: computed(() => quickSearchOpen.value),
                modelDropdownState,
            })
        );

        expect(mounted.result.overlayState.value).toBe('quick-search-open');
        expect(mounted.result.requestModelDropdownOpen()).toBe('close-quick-search');
        expect(mounted.result.overlayState.value).toBe('model-dropdown-preparing');
        expect(mounted.result.handleQuickSearchClosedForModelDropdown()).toBe('wait-layout-stable');
        expect(mounted.result.overlayState.value).toBe('waiting-layout-stable');
        expect(mounted.result.handleLayoutStableForModelDropdown()).toBe('open-model-dropdown');

        mounted.result.handleModelDropdownOpened();
        expect(mounted.result.overlayState.value).toBe('model-dropdown-open');

        modelDropdownState.value = { isOpen: false };
        quickSearchOpen.value = false;
        mounted.result.handleModelDropdownClosed();
        await nextTick();

        expect(mounted.result.overlayState.value).toBe('idle');

        mounted.unmount();
    });

    it('user gets the dropdown opened straight away when no quick search is in the way', async () => {
        const quickSearchOpen = ref(false);
        const modelDropdownState = ref({ isOpen: false });

        const mounted = await mountComposable(() =>
            useSearchOverlayMachine({
                isQuickSearchOpen: computed(() => quickSearchOpen.value),
                modelDropdownState,
            })
        );

        expect(mounted.result.requestModelDropdownOpen()).toBe('open-model-dropdown');

        mounted.unmount();
    });

    it('user gets no second request while the dropdown is already open', async () => {
        const modelDropdownState = ref({ isOpen: true });

        const mounted = await mountComposable(() =>
            useSearchOverlayMachine({
                isQuickSearchOpen: computed(() => false),
                modelDropdownState,
            })
        );

        expect(mounted.result.overlayState.value).toBe('model-dropdown-open');
        expect(mounted.result.requestModelDropdownOpen()).toBe('noop');

        mounted.unmount();
    });

    it('user gets no layout wait when the dropdown was never preparing', async () => {
        const mounted = await mountComposable(() =>
            useSearchOverlayMachine({
                isQuickSearchOpen: computed(() => false),
                modelDropdownState: ref({ isOpen: false }),
            })
        );

        expect(mounted.result.handleQuickSearchClosedForModelDropdown()).toBe('noop');
        expect(mounted.result.handleLayoutStableForModelDropdown()).toBe('noop');

        mounted.unmount();
    });
});
