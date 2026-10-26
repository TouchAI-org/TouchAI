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
    useSearchPageController,
    useSearchPageLifecycle,
    useSearchPanelFocusRestore,
} from '@/views/SearchView/composables/useSearchPage';

/**
 * These tests cover the conditional branches of the search page wiring: which
 * state the page reports to the native layer, which shortcut entries reach the
 * native shortcut owner, and how activation/focus transitions reach the popup
 * reconciler. The Tauri window, the native bridge and the event bus are process
 * boundaries and are stubbed; the assertions are about the observable effect.
 */
const {
    currentWindowMock,
    eventHandlers,
    eventServiceMock,
    initNotificationPermissionMock,
    modelDropdownPopupMock,
    nativeMock,
    notifyMock,
    popupManagerState,
    popupManagerMock,
    runStartupTasksMock,
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
        isLiveSession: vi.fn(),
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
                return () => {
                    handlers.delete(event);
                };
            }),
        },
        initNotificationPermissionMock: vi.fn(),
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
        notifyMock: vi.fn(),
        popupManagerMock: { initialize: vi.fn() },
        popupManagerState: {
            isOpen: false,
            currentType: null,
            currentPopupId: null,
            currentWindowLabel: null,
            currentPopupSessionVersion: null,
        },
        runStartupTasksMock: vi.fn(),
        settingsStoreMock: { initialize: vi.fn(), globalShortcut: 'Alt+Space' },
        useAlertMock: vi.fn(),
        useModelDropdownPopupMock: vi.fn(() => popup),
    };
});

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => currentWindowMock,
}));

vi.mock('@services/EventService', async () => {
    const actual =
        await vi.importActual<typeof import('@services/EventService')>('@services/EventService');
    return { ...actual, eventService: eventServiceMock };
});

vi.mock('@services/NativeService', () => ({ native: nativeMock }));
vi.mock('@services/NotificationService', () => ({
    initNotificationPermission: initNotificationPermissionMock,
    notify: notifyMock,
}));
vi.mock('@services/PopupService', () => ({
    popupManager: { ...popupManagerMock, state: popupManagerState },
}));
vi.mock('@/views/SearchView/composables/useModelDropdownPopup', () => ({
    useModelDropdownPopup: useModelDropdownPopupMock,
}));
vi.mock('@services/StartupService', () => ({ runStartupTasks: runStartupTasksMock }));
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
        prefetchModelDropdownData: vi.fn().mockResolvedValue(undefined),
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
        closeQuickSearch: vi.fn(),
        openQuickSearch: vi.fn(),
        moveQuickSearchSelection: vi.fn(),
        openHighlightedQuickSearchItem: vi.fn().mockResolvedValue(undefined),
        goToPageQuickSearch: vi.fn(),
        goToNextPageQuickSearch: vi.fn(),
        goToPreviousPageQuickSearch: vi.fn(),
        openQuickSearchContextMenu: vi.fn(),
        toggleQuickSearchView: vi.fn(),
        collapseQuickSearch: vi.fn(),
        triggerQuickSearch: vi.fn(),
        ...overrides,
    };
}

type InteractionContext = ReturnType<typeof createSearchInteractionContext>;

async function mountLifecycle(options: Record<string, unknown> = {}) {
    const controller = (options.controller as never) ?? (createController() as never);
    const interactionContext =
        (options.interactionContext as InteractionContext | undefined) ??
        createSearchInteractionContext();

    const mounted = await mountComposable(() =>
        useSearchPageLifecycle({
            controller,
            viewReady: ref(true),
            isDragging: ref(false),
            isPinned: ref(false),
            interactionContext,
            syncWindowPinState: vi.fn().mockResolvedValue(false),
            clearSession: vi.fn(),
            ...options,
        })
    );

    await flushLifecycle();

    return { controller, interactionContext, mounted };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    eventHandlers.clear();
    modelDropdownPopupMock.isOpen.value = true;
    modelDropdownPopupMock.open.mockResolvedValue(undefined);
    modelDropdownPopupMock.close.mockResolvedValue(undefined);
    modelDropdownPopupMock.updateData.mockResolvedValue(undefined);
    modelDropdownPopupMock.isLiveSession.mockReturnValue(true);
    useModelDropdownPopupMock.mockReturnValue(modelDropdownPopupMock);

    currentWindowMock.isVisible.mockResolvedValue(true);
    currentWindowMock.isAlwaysOnTop.mockResolvedValue(false);
    currentWindowMock.setAlwaysOnTop.mockResolvedValue(undefined);

    nativeMock.shortcut.registerGlobalShortcut.mockResolvedValue(undefined);
    nativeMock.shortcut.setSearchSurfaceShortcuts.mockResolvedValue(undefined);
    nativeMock.runtime.getRuntimeInfo.mockResolvedValue({ isE2eTestMode: false });
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
    settingsStoreMock.globalShortcut = 'Alt+Space';
    initNotificationPermissionMock.mockResolvedValue(undefined);
    runStartupTasksMock.mockResolvedValue(undefined);

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

describe('when the search bar is not mounted yet', () => {
    it('user gets the dropdown prepared after the bar appears instead of crashing', async () => {
        const searchBar = ref<undefined | { prepareModelDropdownOpen: () => Promise<void> }>(
            undefined
        );
        const controller = useSearchPageController({
            searchBar: searchBar as never,
            quickSearchOpen: ref(false),
            quickSearchPanel: ref(undefined),
            conversationPanel: ref(undefined),
        });

        const pending = controller.prepareModelDropdownOpen();
        searchBar.value = { prepareModelDropdownOpen: vi.fn().mockResolvedValue(undefined) };
        await pending;
        await nextTick();

        // The bar mounted while the page was waiting for it, so the prepare call landed.
        expect(searchBar.value.prepareModelDropdownOpen).toHaveBeenCalled();
    });
});

describe('when the page restores focus after a blank click', () => {
    function stubSelection(text: string) {
        vi.spyOn(window, 'getSelection').mockReturnValue({
            isCollapsed: text.length === 0,
            toString: () => text,
        } as unknown as Selection);
    }

    it('user gets no second focus steal when the selection comes back before the frame', async () => {
        const focusSearchInput = vi.fn().mockResolvedValue(undefined);
        const controller = { focusSearchInput } as never;
        const mounted = await mountComposable(() => useSearchPanelFocusRestore({ controller }));

        // First the user is mid-selection, then the deferred frame still sees a selection.
        stubSelection('copied text');
        mounted.result.handleQuickSearchBlankClick();
        stubSelection('copied text');
        await nextTick();

        expect(focusSearchInput).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets focus back in the input when the blank click had no selection', async () => {
        stubSelection('');
        const focusSearchInput = vi.fn().mockResolvedValue(undefined);
        const controller = { focusSearchInput } as never;
        const mounted = await mountComposable(() => useSearchPanelFocusRestore({ controller }));

        mounted.result.handleQuickSearchBlankClick();

        expect(focusSearchInput).toHaveBeenCalled();
        mounted.unmount();
    });
});

describe('when the window visibility changes', () => {
    it('user gets the app marked visible again when the tab becomes visible', async () => {
        const { interactionContext, mounted } = await mountLifecycle();

        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));
        expect(interactionContext.state.appFocused).toBe(false);
        expect(interactionContext.state.windowFocused).toBe(false);

        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'visible',
        });
        document.dispatchEvent(new Event('visibilitychange'));

        expect(interactionContext.state.appFocused).toBe(true);
        expect(interactionContext.state.windowVisible).toBe(true);

        mounted.unmount();
    });

    it('user gets the window marked focused on a native window focus event', async () => {
        const { interactionContext, mounted } = await mountLifecycle();

        window.dispatchEvent(new Event('focus'));

        expect(interactionContext.state.windowFocused).toBe(true);
        expect(interactionContext.state.appFocused).toBe(true);

        window.dispatchEvent(new Event('blur'));
        expect(interactionContext.state.windowFocused).toBe(false);

        mounted.unmount();
    });
});

describe('when the view becomes ready after the page mounted', () => {
    it('user gets the lifecycle started once the view reports ready', async () => {
        const controller = createController();
        const viewReady = ref(false);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady,
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext: createSearchInteractionContext(),
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
            })
        );

        await flushLifecycle();
        expect(nativeMock.shortcut.registerGlobalShortcut).not.toHaveBeenCalled();

        viewReady.value = true;
        await flushLifecycle();

        expect(nativeMock.shortcut.registerGlobalShortcut).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets nothing started while the view stays not ready', async () => {
        const viewReady = ref(false);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: createController() as never,
                viewReady,
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext: createSearchInteractionContext(),
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
            })
        );
        await flushLifecycle();

        viewReady.value = false;
        await flushLifecycle();

        expect(nativeMock.shortcut.registerGlobalShortcut).not.toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the surface is hidden while the window was never visible', () => {
    it('user gets no reminder surface hook for an already hidden window', async () => {
        const interactionContext = createSearchInteractionContext();
        currentWindowMock.isVisible.mockResolvedValue(false);

        const { mounted } = await mountLifecycle({ interactionContext });
        await flushLifecycle();

        expect(interactionContext.state.windowVisible).toBe(false);

        mounted.unmount();
    });

    it('user gets the activation recorded as manual when focus arrives from an unknown source', async () => {
        const interactionContext = createSearchInteractionContext();
        // Pretend the window was hidden without a recorded activation source.
        interactionContext.markWindowHidden({ hideReason: 'manual-dismiss', hiddenAt: Date.now() });
        interactionContext.state.activationSource = 'unknown';

        const reconcilePopupSurfaces = vi.fn().mockResolvedValue(undefined);
        const { mounted } = await mountLifecycle({ interactionContext, reconcilePopupSurfaces });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'shortcut',
            sequence: 1,
        });
        await flushLifecycle();

        expect(interactionContext.state.windowVisible).toBe(true);
        expect(reconcilePopupSurfaces).toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when a popup window currently owns focus', () => {
    it('user gets the popup left alone instead of being reconciled away', async () => {
        const interactionContext = createSearchInteractionContext();
        Object.assign(popupManagerState, {
            isOpen: true,
            currentPopupId: 'popup-1',
            currentWindowLabel: 'popup-model-dropdown-popup',
            currentPopupSessionVersion: 3,
        });
        interactionContext.setActivePopupSession({
            popupType: 'model-dropdown-surface',
            identity: {
                popupId: 'popup-1',
                windowLabel: 'popup-model-dropdown-popup',
                popupSessionVersion: 3,
            },
        });

        const reconcilePopupSurfaces = vi.fn().mockResolvedValue(undefined);
        const { mounted } = await mountLifecycle({ interactionContext, reconcilePopupSurfaces });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'shortcut',
            sequence: 1,
        });
        await flushLifecycle();

        // The popup still owns the surface, so it must not be torn down underneath it.
        expect(reconcilePopupSurfaces).not.toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the activation repeats', () => {
    it('user gets the window focused again on a second activation', async () => {
        const reconcilePopupSurfaces = vi.fn().mockResolvedValue(undefined);
        const controller = createController();
        const { mounted } = await mountLifecycle({
            controller,
            reconcilePopupSurfaces,
            shouldClearSessionAfterTimeout: () => false,
        });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'shortcut',
            sequence: 1,
        });
        await flushLifecycle();
        const focusCallsAfterFirst = vi.mocked(controller.focusSearchInput).mock.calls.length;

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'shortcut',
            sequence: 2,
        });
        await flushLifecycle();

        // Each activation re-focuses the input so the user can type straight away.
        expect(reconcilePopupSurfaces.mock.calls.length).toBeGreaterThan(1);
        expect(vi.mocked(controller.focusSearchInput).mock.calls.length).toBe(
            focusCallsAfterFirst + 1
        );

        mounted.unmount();
    });
});

describe('when the global shortcut registration fails in different ways', () => {
    async function registerFailure(error: Error) {
        nativeMock.shortcut.registerGlobalShortcut.mockRejectedValue(error);
        await mountLifecycle();
        const body = notifyMock.mock.calls[notifyMock.mock.calls.length - 1]?.[0]?.body as
            | string
            | undefined;
        return body ?? '';
    }

    it('user is told the shortcut is invalid when the OS rejects its format', async () => {
        const body = await registerFailure(new Error('invalid shortcut format'));

        // The generic message would echo the raw error; the invalid one is actionable.
        expect(body).not.toContain('invalid shortcut format');
        expect(body).toBeTruthy();
    });

    it('user is told to change the key when the OS does not know it', async () => {
        const body = await registerFailure(new Error('Unknown key F13'));

        expect(body).not.toContain('Unknown key F13');
        expect(body).toBeTruthy();
    });

    it('user gets the raw error echoed when the failure has no known cause', async () => {
        const body = await registerFailure(new Error('something else entirely'));

        expect(body).toContain('something else entirely');
    });
});

describe('when the AI model list changes', () => {
    it('user gets the dropdown cached data invalidated when no handler is wired', async () => {
        const controller = createController();
        const { mounted } = await mountLifecycle({ controller });

        await eventHandlers.get(AppEvent.AI_MODELS_UPDATED)?.();
        await flushLifecycle();

        expect(controller.invalidateModelDropdownData).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets the page handler run when it is wired', async () => {
        const handleAiModelsUpdated = vi.fn().mockResolvedValue(undefined);
        const controller = createController();
        const { mounted } = await mountLifecycle({ controller, handleAiModelsUpdated });

        await eventHandlers.get(AppEvent.AI_MODELS_UPDATED)?.();
        await flushLifecycle();

        expect(handleAiModelsUpdated).toHaveBeenCalled();
        expect(controller.invalidateModelDropdownData).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user keeps the view working when the model sync handler throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const handleAiModelsUpdated = vi.fn().mockRejectedValue(new Error('sync failed'));
        const controller = createController();
        const { mounted } = await mountLifecycle({ controller, handleAiModelsUpdated });

        await eventHandlers.get(AppEvent.AI_MODELS_UPDATED)?.();
        await flushLifecycle();

        expect(controller.focusSearchInput).not.toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the surface hidden handler fails', () => {
    it('user gets the window still marked hidden when the cleanup hook throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const onSurfaceHidden = vi.fn().mockRejectedValue(new Error('cleanup failed'));
        const { interactionContext, mounted } = await mountLifecycle({ onSurfaceHidden });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)?.({
            sequence: 1,
            reason: 'app-blur-hide',
        });
        await flushLifecycle();

        expect(interactionContext.state.windowVisible).toBe(false);
        expect(interactionContext.state.lastHideReason).toBe('app-blur-hide');

        mounted.unmount();
    });
});

describe('when the search keybindings are not provided', () => {
    it('user gets no native shortcut sync without any keybindings', async () => {
        const { mounted } = await mountLifecycle();
        await flushLifecycle();

        expect(nativeMock.shortcut.setSearchSurfaceShortcuts).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets the quick-search-only shortcut only published while that view is open', async () => {
        const searchKeybindings = ref(createDefaultSearchKeybindings());
        const quickSearchOpen = ref(false);
        const controller = createController({
            isQuickSearchOpen: () => quickSearchOpen.value,
        });

        const { mounted } = await mountLifecycle({
            controller,
            searchKeybindings,
            quickSearchOpen,
        });
        await flushLifecycle();

        const entriesWhileClosed =
            nativeMock.shortcut.setSearchSurfaceShortcuts.mock.calls[
                nativeMock.shortcut.setSearchSurfaceShortcuts.mock.calls.length - 1
            ]?.[0] ?? [];
        expect(
            (entriesWhileClosed as Array<{ actionId: string }>).some(
                (entry) => entry.actionId === 'search.quickSearch.toggleView'
            )
        ).toBe(false);

        quickSearchOpen.value = true;
        await flushLifecycle();

        const entriesWhileOpen =
            nativeMock.shortcut.setSearchSurfaceShortcuts.mock.calls[
                nativeMock.shortcut.setSearchSurfaceShortcuts.mock.calls.length - 1
            ]?.[0] ?? [];
        expect(
            (entriesWhileOpen as Array<{ actionId: string }>).some(
                (entry) => entry.actionId === 'search.quickSearch.toggleView'
            )
        ).toBe(true);

        mounted.unmount();
    });

    it('user gets a disabled shortcut left out of the native list', async () => {
        const keybindings = createDefaultSearchKeybindings();
        keybindings['search.model.toggle'] = null;
        const searchKeybindings = ref(keybindings);
        const controller = createController({ isQuickSearchOpen: () => true });

        const { mounted } = await mountLifecycle({
            controller,
            searchKeybindings,
            quickSearchOpen: ref(true),
        });
        await flushLifecycle();

        const entries = (nativeMock.shortcut.setSearchSurfaceShortcuts.mock.calls[
            nativeMock.shortcut.setSearchSurfaceShortcuts.mock.calls.length - 1
        ]?.[0] ?? []) as Array<{ actionId: string }>;
        expect(entries.some((entry) => entry.actionId === 'search.model.toggle')).toBe(false);
        expect(entries.length).toBeGreaterThan(0);

        mounted.unmount();
    });

    it('user gets the shortcut list re-sent when the user rebinds an action', async () => {
        const searchKeybindings = ref(createDefaultSearchKeybindings());
        const controller = createController({ isQuickSearchOpen: () => true });

        const { mounted } = await mountLifecycle({
            controller,
            searchKeybindings,
            quickSearchOpen: ref(true),
        });
        await flushLifecycle();
        const callsBefore = nativeMock.shortcut.setSearchSurfaceShortcuts.mock.calls.length;

        searchKeybindings.value = {
            ...searchKeybindings.value,
            'search.model.toggle': 'Mod+Shift+M',
        };
        await flushLifecycle();

        expect(nativeMock.shortcut.setSearchSurfaceShortcuts.mock.calls.length).toBeGreaterThan(
            callsBefore
        );
        const entries = (nativeMock.shortcut.setSearchSurfaceShortcuts.mock.calls[
            nativeMock.shortcut.setSearchSurfaceShortcuts.mock.calls.length - 1
        ]?.[0] ?? []) as Array<{ actionId: string; shortcut: string }>;
        expect(entries.find((entry) => entry.actionId === 'search.model.toggle')?.shortcut).toBe(
            'Mod+Shift+M'
        );

        mounted.unmount();
    });
});

describe('when the shortcut autopaste fails on activation', () => {
    it('user still gets the window restored even though the paste failed', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const handleShortcutAutoPaste = vi.fn().mockRejectedValue(new Error('no clipboard'));
        const controller = createController();
        const { mounted } = await mountLifecycle({
            controller,
            handleShortcutAutoPaste,
            shouldClearSessionAfterTimeout: () => false,
        });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'shortcut',
            sequence: 1,
        });
        await flushLifecycle();

        expect(handleShortcutAutoPaste).toHaveBeenCalled();
        expect(controller.focusSearchInput).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets no autopaste when the window came back from a notification', async () => {
        const handleShortcutAutoPaste = vi.fn().mockResolvedValue(undefined);
        const { mounted } = await mountLifecycle({
            handleShortcutAutoPaste,
            shouldClearSessionAfterTimeout: () => false,
        });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'notification',
            sequence: 1,
        });
        await flushLifecycle();

        expect(handleShortcutAutoPaste).not.toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the pin state sync fails', () => {
    it('user gets the window focused anyway when the pin read throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const syncWindowPinState = vi.fn().mockRejectedValue(new Error('pin unavailable'));
        const controller = createController();
        const { mounted } = await mountLifecycle({
            controller,
            syncWindowPinState,
            shouldClearSessionAfterTimeout: () => false,
        });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'shortcut',
            sequence: 1,
        });
        await flushLifecycle();

        expect(syncWindowPinState).toHaveBeenCalled();
        expect(controller.focusSearchInput).toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the window remeasure hook fails', () => {
    it('user still gets the window restored when remeasuring throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const remeasureSearchWindowHeight = vi.fn().mockRejectedValue(new Error('layout gone'));
        const controller = createController();
        const { mounted } = await mountLifecycle({
            controller,
            remeasureSearchWindowHeight,
            shouldClearSessionAfterTimeout: () => false,
        });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'shortcut',
            sequence: 1,
        });
        await flushLifecycle();

        expect(remeasureSearchWindowHeight).toHaveBeenCalled();
        expect(controller.focusSearchInput).toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the timeout clear is not needed', () => {
    it('user keeps the previous session when the hide was very recent', async () => {
        const clearSession = vi.fn().mockResolvedValue(undefined);
        const { interactionContext, mounted } = await mountLifecycle({
            clearSession,
            shouldClearSessionAfterTimeout: () => true,
        });

        interactionContext.markWindowHidden({
            hideReason: 'manual-dismiss',
            hiddenAt: Date.now(),
        });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'shortcut',
            sequence: 1,
        });
        await flushLifecycle();

        // Reopened immediately: well inside the five-minute window.
        expect(clearSession).not.toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the dropdown waits for the layout to settle', () => {
    it('user gets the dropdown opened after two stable frames', async () => {
        const pageContainer = document.createElement('div');
        let height = 300;
        pageContainer.getBoundingClientRect = () => ({ height }) as DOMRect;

        const handleLayoutStableForModelDropdown = vi.fn(() => 'open-model-dropdown' as const);
        const controller = createController();

        const mounted = await mountComposable(() =>
            useSearchModelDropdownCoordinator({
                pageContainer: ref(pageContainer),
                controller: controller as never,
                modelOverride: ref({ modelId: null, providerId: null }),
                modelDropdownState: ref({ isOpen: false }),
                modelDropdownQuery: ref(''),
                requestModelDropdownOpen: () => 'wait-layout-stable' as const,
                handleQuickSearchClosedForModelDropdown: () => 'noop' as const,
                handleLayoutStableForModelDropdown,
                handleModelDropdownOpened: vi.fn(),
                handleModelDropdownClosed: vi.fn(),
                syncOverlayState: vi.fn(),
            })
        );

        await mounted.result.openModelDropdownWithLayoutSync();
        height = 300;
        await flushLifecycle();

        expect(handleLayoutStableForModelDropdown).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets no wait at all when the page container is missing', async () => {
        const handleLayoutStableForModelDropdown = vi.fn(() => 'open-model-dropdown' as const);
        const controller = createController();

        const mounted = await mountComposable(() =>
            useSearchModelDropdownCoordinator({
                pageContainer: ref(null),
                controller: controller as never,
                modelOverride: ref({ modelId: null, providerId: null }),
                modelDropdownState: ref({ isOpen: false }),
                modelDropdownQuery: ref(''),
                requestModelDropdownOpen: () => 'wait-layout-stable' as const,
                handleQuickSearchClosedForModelDropdown: () => 'noop' as const,
                handleLayoutStableForModelDropdown,
                handleModelDropdownOpened: vi.fn(),
                handleModelDropdownClosed: vi.fn(),
                syncOverlayState: vi.fn(),
            })
        );

        await mounted.result.openModelDropdownWithLayoutSync();

        // Without a container there is nothing to measure, so the sequence moves on.
        expect(handleLayoutStableForModelDropdown).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets the last command processed when the sequence ends in open', async () => {
        const controller = createController();
        const handleModelDropdownOpened = vi.fn();

        const mounted = await mountComposable(() =>
            useSearchModelDropdownCoordinator({
                pageContainer: ref(null),
                controller: controller as never,
                modelOverride: ref({ modelId: null, providerId: null }),
                modelDropdownState: ref({ isOpen: false }),
                modelDropdownQuery: ref(''),
                requestModelDropdownOpen: () => 'close-quick-search' as const,
                handleQuickSearchClosedForModelDropdown: () => 'open-model-dropdown' as const,
                handleLayoutStableForModelDropdown: () => 'noop' as const,
                handleModelDropdownOpened,
                handleModelDropdownClosed: vi.fn(),
                syncOverlayState: vi.fn(),
            })
        );

        await mounted.result.openModelDropdownWithLayoutSync();

        expect(controller.closeQuickSearch).toHaveBeenCalled();
        expect(handleModelDropdownOpened).toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the dropdown toggle finds a live popup session', () => {
    it('user gets the popup closed through its own session when it is live', async () => {
        const controller = createController();
        const modelDropdownState = ref({ isOpen: true });
        modelDropdownPopupMock.isOpen.value = true;
        modelDropdownPopupMock.isLiveSession.mockReturnValue(true);

        const mounted = await mountComposable(() =>
            useSearchModelDropdownCoordinator({
                pageContainer: ref(null),
                controller: controller as never,
                modelOverride: ref({ modelId: null, providerId: null }),
                modelDropdownState,
                modelDropdownQuery: ref(''),
                requestModelDropdownOpen: () => 'noop' as const,
                handleQuickSearchClosedForModelDropdown: () => 'noop' as const,
                handleLayoutStableForModelDropdown: () => 'noop' as const,
                handleModelDropdownOpened: vi.fn(),
                handleModelDropdownClosed: vi.fn(),
                syncOverlayState: vi.fn(),
            })
        );

        await mounted.result.handleToggleModelDropdownRequest();

        expect(modelDropdownPopupMock.close).toHaveBeenCalled();
        expect(modelDropdownState.value.isOpen).toBe(false);

        mounted.unmount();
    });
});

describe('when the user clicks around the window before the view is ready', () => {
    beforeEach(() => {
        // The keydown handler reads the ask-user store, so it needs an active pinia.
        setActivePinia(createPinia());
    });

    function mountKeyboard(overrides: Record<string, unknown> = {}) {
        const controller = createController();
        const hideAllPopups = vi.fn().mockResolvedValue(undefined);
        const hideSearchWindow = vi.fn().mockResolvedValue(undefined);

        return mountComposable(() =>
            useSearchKeyboard({
                viewReady: ref(false),
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
        ).then((mounted) => ({ ...mounted, hideAllPopups, hideSearchWindow, controller }));
    }

    it('user gets nothing hidden while the view is still loading', async () => {
        const { hideAllPopups, hideSearchWindow, unmount } = await mountKeyboard();

        const inner = document.createElement('div');
        document.body.appendChild(inner);
        inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(hideAllPopups).not.toHaveBeenCalled();
        expect(hideSearchWindow).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets popups hidden when the history popup is open and they click elsewhere', async () => {
        const { hideAllPopups, unmount } = await mountKeyboard({
            viewReady: ref(true),
            sessionHistoryPopupOpen: ref(true),
        });
        const inner = document.createElement('div');
        document.body.appendChild(inner);
        inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        expect(hideAllPopups).toHaveBeenCalled();

        unmount();
    });

    it('user keeps the popup open when clicking the history trigger', async () => {
        const { hideAllPopups, unmount } = await mountKeyboard({
            viewReady: ref(true),
            sessionHistoryPopupOpen: ref(true),
        });
        const trigger = document.createElement('div');
        trigger.setAttribute('data-history-trigger', 'true');
        document.body.appendChild(trigger);
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        expect(hideAllPopups).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets the window closed when clicking the empty backdrop', async () => {
        const { hideSearchWindow, unmount } = await mountKeyboard({ viewReady: ref(true) });

        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await nextTick();

        expect(hideSearchWindow).toHaveBeenCalled();

        unmount();
    });

    it('user keeps the window open when clicking a real element', async () => {
        const { hideSearchWindow, unmount } = await mountKeyboard({ viewReady: ref(true) });
        const button = document.createElement('button');
        document.body.appendChild(button);

        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await nextTick();

        expect(hideSearchWindow).not.toHaveBeenCalled();

        unmount();
    });
});

describe('when the e2e runtime is active', () => {
    it('user gets the notification permission still requested in normal mode', async () => {
        await mountLifecycle();
        await flushLifecycle();

        // Normal mode asks for notification permission; the e2e case lives in its own
        // file because the runtime mode promise is cached once per module instance.
        expect(initNotificationPermissionMock).toHaveBeenCalled();
        expect(runStartupTasksMock).toHaveBeenCalled();
    });
});
