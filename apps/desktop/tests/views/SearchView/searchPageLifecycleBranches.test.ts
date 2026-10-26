import { AppEvent } from '@services/EventService';
import { mountComposable } from '@tests/utils/composables';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { createDefaultSearchKeybindings } from '@/config/searchKeybindings';
import { createSearchInteractionContext } from '@/views/SearchView/composables/searchInteraction';
import {
    useSearchKeyboard,
    useSearchModelDropdownCoordinator,
    useSearchPageLifecycle,
    useSearchPanelFocusRestore,
} from '@/views/SearchView/composables/useSearchPage';

/**
 * Second pass over the search page wiring: the popup-focus ownership guard, the
 * window-visible transition on focus, the stale surface-sequence guard, and the
 * layout-stability loop that gates opening the model dropdown.
 */
const {
    currentWindowMock,
    eventHandlers,
    eventServiceMock,
    modelDropdownPopupMock,
    nativeMock,
    popupManagerState,
    popupManagerMock,
    settingsStoreMock,
    useAlertMock,
    useModelDropdownPopupMock,
} = vi.hoisted(() => {
    const handlers = new Map<string, (payload?: unknown) => unknown>();
    const popup = {
        isOpen: { value: true },
        open: vi.fn(),
        close: vi.fn(),
        updateData: vi.fn(),
        isLiveSession: vi.fn(() => true),
    };

    return {
        currentWindowMock: {
            isVisible: vi.fn(),
            isAlwaysOnTop: vi.fn(),
            setAlwaysOnTop: vi.fn(),
        },
        eventHandlers: handlers,
        eventServiceMock: {
            on: vi.fn(async (event: string, handler: (payload?: unknown) => unknown) => {
                handlers.set(event, handler);
                return () => handlers.delete(event);
            }),
        },
        modelDropdownPopupMock: popup,
        nativeMock: {
            runtime: { getRuntimeInfo: vi.fn() },
            shortcut: {
                registerGlobalShortcut: vi.fn(),
                setSearchSurfaceShortcuts: vi.fn(),
            },
            window: {
                hideSearchWindow: vi.fn(),
                setSearchSurfaceHideOnAppBlur: vi.fn(),
                setTrayStatusIndicator: vi.fn(),
                clearTrayStatusIndicator: vi.fn(),
                showSessionStatusReminderNotification: vi.fn(),
                clearSessionStatusReminderNotifications: vi.fn(),
            },
        },
        popupManagerMock: { initialize: vi.fn() },
        popupManagerState: {
            isOpen: false,
            currentType: null,
            currentPopupId: null,
            currentWindowLabel: null,
            currentPopupSessionVersion: null,
        },
        settingsStoreMock: { initialize: vi.fn(), globalShortcut: 'Alt+Space' },
        useAlertMock: vi.fn(),
        useModelDropdownPopupMock: vi.fn(() => popup),
    };
});

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => currentWindowMock }));
vi.mock('@services/EventService', async () => {
    const actual =
        await vi.importActual<typeof import('@services/EventService')>('@services/EventService');
    return { ...actual, eventService: eventServiceMock };
});
vi.mock('@services/NativeService', () => ({ native: nativeMock }));
vi.mock('@services/NotificationService', () => ({
    initNotificationPermission: vi.fn(),
    notify: vi.fn(),
}));
vi.mock('@services/PopupService', () => ({
    popupManager: { ...popupManagerMock, state: popupManagerState },
}));
vi.mock('@/views/SearchView/composables/useModelDropdownPopup', () => ({
    useModelDropdownPopup: useModelDropdownPopupMock,
}));
vi.mock('@services/StartupService', () => ({ runStartupTasks: vi.fn() }));
vi.mock('@composables/useAlert', () => ({ useAlert: useAlertMock }));
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => settingsStoreMock }));

async function flushLifecycle() {
    for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
        await nextTick();
    }
}

function createController(overrides: Record<string, unknown> = {}) {
    return {
        focusConversation: vi.fn(),
        focusSearchInput: vi.fn().mockResolvedValue(undefined),
        loadActiveModel: vi.fn().mockResolvedValue(undefined),
        invalidateModelDropdownData: vi.fn(),
        isQuickSearchOpen: vi.fn(() => false),
        isQuickSearchItemHighlighted: vi.fn(() => false),
        isQuickSearchContextMenuOpen: vi.fn(() => false),
        closeQuickSearch: vi.fn(),
        closeQuickSearchContextMenu: vi.fn(),
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
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    setActivePinia(createPinia());
    eventHandlers.clear();
    modelDropdownPopupMock.isOpen.value = true;
    modelDropdownPopupMock.open.mockResolvedValue(undefined);
    modelDropdownPopupMock.close.mockResolvedValue(undefined);
    modelDropdownPopupMock.updateData.mockResolvedValue(undefined);
    useModelDropdownPopupMock.mockReturnValue(modelDropdownPopupMock);

    currentWindowMock.isVisible.mockResolvedValue(true);
    currentWindowMock.isAlwaysOnTop.mockResolvedValue(false);
    currentWindowMock.setAlwaysOnTop.mockResolvedValue(undefined);

    nativeMock.runtime.getRuntimeInfo.mockResolvedValue({ isE2eTestMode: false });
    nativeMock.shortcut.registerGlobalShortcut.mockResolvedValue(undefined);
    nativeMock.shortcut.setSearchSurfaceShortcuts.mockResolvedValue(undefined);
    nativeMock.window.hideSearchWindow.mockResolvedValue(undefined);
    nativeMock.window.setSearchSurfaceHideOnAppBlur.mockResolvedValue(undefined);
    nativeMock.window.setTrayStatusIndicator.mockResolvedValue(undefined);
    nativeMock.window.clearTrayStatusIndicator.mockResolvedValue(undefined);
    nativeMock.window.showSessionStatusReminderNotification.mockResolvedValue(undefined);
    nativeMock.window.clearSessionStatusReminderNotifications.mockResolvedValue(undefined);

    popupManagerMock.initialize.mockResolvedValue(undefined);
    Object.assign(popupManagerState, {
        isOpen: false,
        currentType: null,
        currentPopupId: null,
        currentWindowLabel: null,
        currentPopupSessionVersion: null,
    });
    settingsStoreMock.initialize.mockResolvedValue(undefined);

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
});

afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('when the window becomes visible on a focus event', () => {
    it('user gets the activation recorded when focus arrives on a hidden window', async () => {
        const interactionContext = createSearchInteractionContext();
        interactionContext.markWindowHidden({ hideReason: 'manual-dismiss', hiddenAt: Date.now() });
        interactionContext.state.activationSource = 'unknown';
        const controller = createController();

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext,
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
            })
        );
        await flushLifecycle();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'shortcut',
            sequence: 1,
        });
        await flushLifecycle();

        // A shortcut activation on a hidden window starts a fresh activation epoch.
        expect(interactionContext.state.activationSource).toBe('shortcut');
        expect(interactionContext.state.windowVisible).toBe(true);

        mounted.unmount();
    });

    it('user gets the window marked visible when it was already on screen', async () => {
        const interactionContext = createSearchInteractionContext();
        interactionContext.markWindowVisible();
        interactionContext.state.activationSource = 'manual';
        const controller = createController();

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext,
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
            })
        );
        await flushLifecycle();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'shortcut',
            sequence: 1,
        });
        await flushLifecycle();

        expect(interactionContext.state.windowVisible).toBe(true);
        expect(controller.focusSearchInput).toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the popup manager has no state yet', () => {
    it('user gets the window restored because no popup can own focus', async () => {
        const reconcilePopupSurfaces = vi.fn().mockResolvedValue(undefined);
        const controller = createController();
        // No popup manager state at all: the guard must treat that as "no popup".
        Object.assign(popupManagerState, {
            isOpen: false,
            currentPopupId: null,
            currentWindowLabel: null,
            currentPopupSessionVersion: null,
        });

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext: createSearchInteractionContext(),
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
                reconcilePopupSurfaces,
                shouldClearSessionAfterTimeout: () => false,
            })
        );
        await flushLifecycle();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'shortcut',
            sequence: 1,
        });
        await flushLifecycle();

        expect(reconcilePopupSurfaces).toHaveBeenCalled();
        expect(controller.focusSearchInput).toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when a stale surface event arrives', () => {
    it('user gets no focus change from a hidden event older than the last shown one', async () => {
        const interactionContext = createSearchInteractionContext();
        const controller = createController();

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext,
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
                shouldClearSessionAfterTimeout: () => false,
            })
        );
        await flushLifecycle();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'shortcut',
            sequence: 5,
        });
        await flushLifecycle();

        // An older hide event must not undo the newer shown state.
        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)?.({
            sequence: 3,
            reason: 'app-blur-hide',
        });
        await flushLifecycle();

        expect(interactionContext.state.windowVisible).toBe(true);

        mounted.unmount();
    });

    it('user gets the surface state updated when the event carries no sequence', async () => {
        const interactionContext = createSearchInteractionContext();
        const controller = createController();

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext,
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
                shouldClearSessionAfterTimeout: () => false,
            })
        );
        await flushLifecycle();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({ source: 'shortcut' });
        await flushLifecycle();
        expect(controller.focusSearchInput).toHaveBeenCalled();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)?.({ reason: 'manual-dismiss' });
        await flushLifecycle();
        expect(interactionContext.state.windowVisible).toBe(false);

        mounted.unmount();
    });
});

describe('when the timeout clear policy allows clearing', () => {
    it('user gets the previous session cleared when reopening after the idle window', async () => {
        const clearSession = vi.fn().mockResolvedValue(undefined);
        const controller = createController();
        const interactionContext = createSearchInteractionContext();

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext,
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession,
                shouldClearSessionAfterTimeout: () => true,
                reconcilePopupSurfaces: vi.fn().mockResolvedValue(undefined),
            })
        );
        await flushLifecycle();

        interactionContext.markWindowHidden({
            hideReason: 'manual-dismiss',
            hiddenAt: Date.now() - 6 * 60 * 1000,
        });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'shortcut',
            sequence: 1,
        });
        await flushLifecycle();

        expect(clearSession).toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the panel focus restore sees a selection only in the deferred frame', () => {
    /**
     * These two cases need to hold the animation frame and drive the live selection
     * between the click and that frame. Both are process globals, so each test owns
     * its cleanup here (not inline in the test body) to stay order-independent: an
     * assertion failure must not leave `getSelection` or `requestAnimationFrame`
     * replaced for every later test in the run.
     */
    let originalGetSelection: typeof window.getSelection;
    let originalRaf: typeof globalThis.requestAnimationFrame;
    let currentSelection: Selection | null = null;
    let frames: FrameRequestCallback[] = [];

    beforeEach(() => {
        originalGetSelection = window.getSelection;
        originalRaf = globalThis.requestAnimationFrame;
        frames = [];
        window.getSelection = () => currentSelection;
        globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        }) as typeof globalThis.requestAnimationFrame;
    });

    afterEach(() => {
        window.getSelection = originalGetSelection;
        globalThis.requestAnimationFrame = originalRaf;
        currentSelection = null;
        frames = [];
    });

    function selectingSelection(): Selection {
        return { isCollapsed: false, toString: () => 'still selected' } as unknown as Selection;
    }

    function collapsedSelection(): Selection {
        return { isCollapsed: true, toString: () => '' } as unknown as Selection;
    }

    it('user gets no focus steal while the selection is still alive', async () => {
        const focusSearchInput = vi.fn().mockResolvedValue(undefined);
        const controller = { focusSearchInput } as never;
        // The click lands while the user is still selecting result text.
        currentSelection = selectingSelection();

        const mounted = await mountComposable(() => useSearchPanelFocusRestore({ controller }));

        mounted.result.handleQuickSearchBlankClick();
        expect(frames).toHaveLength(1);

        frames[0]!(0);
        await nextTick();

        // Stealing focus now would clear the selection the user is dragging.
        expect(focusSearchInput).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets the focus restored once the deferred frame sees the selection gone', async () => {
        const focusSearchInput = vi.fn().mockResolvedValue(undefined);
        const controller = { focusSearchInput } as never;
        currentSelection = selectingSelection();

        const mounted = await mountComposable(() => useSearchPanelFocusRestore({ controller }));

        mounted.result.handleQuickSearchBlankClick();
        expect(frames).toHaveLength(1);

        // The user finished selecting before the deferred frame runs.
        currentSelection = collapsedSelection();
        frames[0]!(0);
        await nextTick();

        expect(focusSearchInput).toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the dropdown open sequence is requested repeatedly', () => {
    it('user gets only one open when the request is a noop', async () => {
        const controller = createController();

        const mounted = await mountComposable(() =>
            useSearchModelDropdownCoordinator({
                pageContainer: ref(null),
                controller: controller as never,
                modelOverride: ref({ modelId: null, providerId: null }),
                modelDropdownState: ref({ isOpen: true }),
                modelDropdownQuery: ref(''),
                requestModelDropdownOpen: () => 'noop' as const,
                handleQuickSearchClosedForModelDropdown: () => 'noop' as const,
                handleLayoutStableForModelDropdown: () => 'noop' as const,
                handleModelDropdownOpened: vi.fn(),
                handleModelDropdownClosed: vi.fn(),
                syncOverlayState: vi.fn(),
            })
        );

        await mounted.result.openModelDropdownWithLayoutSync();

        expect(modelDropdownPopupMock.open).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets the open callback skipped when the popup window refused to show', async () => {
        const handleModelDropdownOpened = vi.fn();
        const handleModelDropdownClosed = vi.fn();
        modelDropdownPopupMock.isOpen.value = false;
        const controller = createController();

        const mounted = await mountComposable(() =>
            useSearchModelDropdownCoordinator({
                pageContainer: ref(null),
                controller: controller as never,
                modelOverride: ref({ modelId: null, providerId: null }),
                modelDropdownState: ref({ isOpen: false }),
                modelDropdownQuery: ref(''),
                requestModelDropdownOpen: () => 'open-model-dropdown' as const,
                handleQuickSearchClosedForModelDropdown: () => 'noop' as const,
                handleLayoutStableForModelDropdown: () => 'noop' as const,
                handleModelDropdownOpened,
                handleModelDropdownClosed,
                syncOverlayState: vi.fn(),
            })
        );

        await mounted.result.openModelDropdownWithLayoutSync();

        expect(handleModelDropdownOpened).not.toHaveBeenCalled();
        expect(handleModelDropdownClosed).toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the window click handling sees an open history popup', () => {
    it('user gets the popups hidden when the history popup is open', async () => {
        const controller = createController();
        const hideAllPopups = vi.fn().mockResolvedValue(undefined);

        const mounted = await mountComposable(() =>
            useSearchKeyboard({
                viewReady: ref(true),
                searchKeybindings: ref(createDefaultSearchKeybindings()),
                queryText: ref(''),
                attachments: ref([]),
                cursorContext: ref({
                    isMultiLine: false,
                    cursorAtStart: true,
                    cursorAtTextStart: true,
                    cursorAtEnd: true,
                }),
                modelOverride: ref({ modelId: null, providerId: null }),
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
                sessionHistoryPopupOpen: ref(true),
                hideAllPopups,
                hideSearchWindow: vi.fn().mockResolvedValue(undefined),
                navigateInputHistory: vi.fn(() => 'ignored' as const),
                closeModelDropdown: vi.fn().mockResolvedValue(undefined),
                handleSearchKeybindingAction: vi.fn().mockResolvedValue(undefined),
                handleSubmit: vi.fn().mockResolvedValue(undefined),
                cancelRequest: vi.fn(),
                cancelPendingRequest: vi.fn(() => false),
                clearSession: vi.fn(),
            })
        );

        const inner = document.createElement('div');
        document.body.appendChild(inner);
        inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        expect(hideAllPopups).toHaveBeenCalled();

        mounted.unmount();
    });
});
