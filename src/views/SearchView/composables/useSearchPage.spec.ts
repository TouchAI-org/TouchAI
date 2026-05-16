import { AppEvent } from '@services/EventService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { mountComposable } from '../../../../tests/utils/composables';
import { createSearchInteractionContext } from './searchInteraction';
import { useSearchPageLifecycle } from './useSearchPage';

const {
    currentWindowMock,
    eventHandlers,
    eventServiceMock,
    initNotificationPermissionMock,
    nativeMock,
    popupManagerMock,
    popupManagerState,
    runStartupTasksMock,
    settingsStoreMock,
    useAlertMock,
} = vi.hoisted(() => {
    const handlers = new Map<string, (payload?: unknown) => unknown>();

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
        nativeMock: {
            shortcut: {
                registerGlobalShortcut: vi.fn(),
            },
            window: {
                hideSearchWindow: vi.fn(),
                setSearchSurfaceHideOnAppBlur: vi.fn(),
            },
        },
        popupManagerMock: {
            initialize: vi.fn(),
        },
        popupManagerState: {
            isOpen: false,
            currentType: null,
            currentPopupId: null,
            currentWindowLabel: null,
            currentPopupSessionVersion: null,
        },
        runStartupTasksMock: vi.fn(),
        settingsStoreMock: {
            initialize: vi.fn(),
            globalShortcut: 'Alt+Space',
        },
        useAlertMock: vi.fn(),
    };
});

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => currentWindowMock,
}));

vi.mock('@services/EventService', async () => {
    const actual =
        await vi.importActual<typeof import('@services/EventService')>('@services/EventService');
    return {
        ...actual,
        eventService: eventServiceMock,
    };
});

vi.mock('@services/NativeService', () => ({
    native: nativeMock,
}));

vi.mock('@services/NotificationService', () => ({
    initNotificationPermission: initNotificationPermissionMock,
    notify: vi.fn(),
}));

vi.mock('@services/PopupService', () => ({
    popupManager: {
        ...popupManagerMock,
        state: popupManagerState,
    },
}));

vi.mock('@services/StartupService', () => ({
    runStartupTasks: runStartupTasksMock,
}));

vi.mock('@composables/useAlert', () => ({
    useAlert: useAlertMock,
}));

vi.mock('@/stores/settings', () => ({
    useSettingsStore: () => settingsStoreMock,
}));

async function flushLifecycle() {
    for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
        await nextTick();
    }
}

function createController() {
    return {
        focusSearchInput: vi.fn().mockResolvedValue(undefined),
        loadActiveModel: vi.fn().mockResolvedValue(undefined),
        invalidateModelDropdownData: vi.fn(),
    };
}

describe('useSearchPageLifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();

        currentWindowMock.isVisible.mockResolvedValue(true);
        currentWindowMock.isAlwaysOnTop.mockResolvedValue(false);
        currentWindowMock.setAlwaysOnTop.mockResolvedValue(undefined);

        nativeMock.shortcut.registerGlobalShortcut.mockResolvedValue(undefined);
        nativeMock.window.hideSearchWindow.mockResolvedValue(undefined);
        nativeMock.window.setSearchSurfaceHideOnAppBlur.mockResolvedValue(undefined);

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
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('initializes the search view lifecycle and keeps the app-blur hide policy in sync', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
        const isDragging = ref(false);
        const isPinned = ref(false);
        const isMaximized = ref(false);
        const syncWindowPinState = vi.fn().mockResolvedValue(false);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging,
                isPinned,
                isMaximized,
                interactionContext,
                syncWindowPinState,
                clearSession: vi.fn(),
            })
        );

        expect(nativeMock.window.setSearchSurfaceHideOnAppBlur).toHaveBeenCalledWith(true);
        await flushLifecycle();

        expect(settingsStoreMock.initialize).toHaveBeenCalledTimes(1);
        expect(nativeMock.shortcut.registerGlobalShortcut).toHaveBeenCalledWith('Alt+Space');
        expect(useAlertMock).toHaveBeenCalledTimes(1);
        expect(popupManagerMock.initialize).toHaveBeenCalledTimes(1);
        expect(currentWindowMock.isVisible).toHaveBeenCalledTimes(1);
        expect(syncWindowPinState).toHaveBeenCalledTimes(1);
        expect(eventHandlers.has(AppEvent.AI_MODELS_UPDATED)).toBe(true);
        expect(eventHandlers.has(AppEvent.SEARCH_SURFACE_SHOWN)).toBe(true);
        expect(eventHandlers.has(AppEvent.SEARCH_SURFACE_HIDDEN)).toBe(true);

        isPinned.value = true;
        await nextTick();

        expect(nativeMock.window.setSearchSurfaceHideOnAppBlur).toHaveBeenLastCalledWith(false);

        mounted.unmount();
    });

    it('invalidates model dropdown data on AI model refresh when no custom handler is supplied', async () => {
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
                clearSession: vi.fn(),
            })
        );

        await flushLifecycle();

        await eventHandlers.get(AppEvent.AI_MODELS_UPDATED)?.();
        await flushLifecycle();

        expect(controller.invalidateModelDropdownData).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });

    it('ignores stale hidden events and only clears the active popup session for the latest surface sequence', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
        const onSurfaceHidden = vi.fn().mockResolvedValue(undefined);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext,
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
                onSurfaceHidden,
            })
        );

        await flushLifecycle();

        interactionContext.setActivePopupSession({
            popupType: 'model-dropdown-surface',
            identity: {
                popupId: 'popup-model-dropdown-popup:1',
                windowLabel: 'popup-model-dropdown-popup',
                popupSessionVersion: 1,
            },
        });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({ sequence: 2 });
        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)?.({
            sequence: 1,
            reason: 'manual-dismiss',
        });
        await flushLifecycle();

        expect(onSurfaceHidden).not.toHaveBeenCalled();
        expect(interactionContext.state.lastHideReason).toBeNull();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)?.({
            sequence: 2,
            reason: 'manual-dismiss',
        });
        await flushLifecycle();

        expect(onSurfaceHidden).toHaveBeenCalledTimes(1);
        expect(interactionContext.state.activePopupIdentity).toBeNull();
        expect(interactionContext.state.lastHideReason).toBe('manual-dismiss');

        mounted.unmount();
    });

    it('restores search focus and clears timed-out sessions when the search surface is shown again after app-blur hide', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
        const clearSession = vi.fn().mockResolvedValue(undefined);
        const reconcilePopupSurfaces = vi.fn().mockResolvedValue(undefined);
        const handleShortcutAutoPaste = vi.fn().mockResolvedValue(undefined);
        const syncWindowPinState = vi.fn().mockResolvedValue(false);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext,
                syncWindowPinState,
                clearSession,
                reconcilePopupSurfaces,
                handleShortcutAutoPaste,
            })
        );

        await flushLifecycle();

        interactionContext.markWindowHidden({
            hideReason: 'app-blur-hide',
            hiddenAt: Date.now() - 5 * 60 * 1000 - 1,
        });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({ sequence: 1 });
        await flushLifecycle();

        expect(clearSession).toHaveBeenCalledTimes(1);
        expect(reconcilePopupSurfaces).toHaveBeenCalledTimes(1);
        expect(controller.focusSearchInput).toHaveBeenCalledTimes(1);
        expect(controller.loadActiveModel).toHaveBeenCalledTimes(1);
        expect(syncWindowPinState).toHaveBeenCalledTimes(2);
        expect(handleShortcutAutoPaste).toHaveBeenCalledTimes(1);
        expect(interactionContext.state.activationSource).toBe('shortcut');
        expect(interactionContext.state.windowFocused).toBe(true);

        mounted.unmount();
    });
});
