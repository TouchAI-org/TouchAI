import { AppEvent } from '@services/EventService';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { getSessionStatusReminderContent } from '@/utils/session';
import { createSearchInteractionContext } from '@/views/SearchView/composables/searchInteraction';
import { useSearchPageLifecycle } from '@/views/SearchView/composables/useSearchPage';

const {
    currentWindowMock,
    eventHandlers,
    eventServiceMock,
    clearStatusReminderNotificationsMock,
    initNotificationPermissionMock,
    nativeMock,
    notifyMock,
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
        clearStatusReminderNotificationsMock: vi.fn(),
        initNotificationPermissionMock: vi.fn(),
        notifyMock: vi.fn(),
        nativeMock: {
            runtime: {
                getRuntimeInfo: vi.fn(),
            },
            shortcut: {
                registerGlobalShortcut: vi.fn(),
            },
            window: {
                hideSearchWindow: vi.fn(),
                setTrayBadgeCount: vi.fn(),
                clearTrayBadge: vi.fn(),
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
    clearStatusReminderNotifications: clearStatusReminderNotificationsMock,
    initNotificationPermission: initNotificationPermissionMock,
    notify: notifyMock,
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
    for (let index = 0; index < 8; index += 1) {
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
        vi.useFakeTimers();
        eventHandlers.clear();

        currentWindowMock.isVisible.mockResolvedValue(true);
        currentWindowMock.isAlwaysOnTop.mockResolvedValue(false);
        currentWindowMock.setAlwaysOnTop.mockResolvedValue(undefined);

        nativeMock.shortcut.registerGlobalShortcut.mockResolvedValue(undefined);
        nativeMock.runtime.getRuntimeInfo.mockResolvedValue({ isE2eTestMode: false });
        nativeMock.window.hideSearchWindow.mockResolvedValue(undefined);
        nativeMock.window.setTrayBadgeCount.mockResolvedValue(undefined);
        nativeMock.window.clearTrayBadge.mockResolvedValue(undefined);
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
        clearStatusReminderNotificationsMock.mockResolvedValue(undefined);
        initNotificationPermissionMock.mockResolvedValue(undefined);
        runStartupTasksMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
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

    it('shows a foreground status overlay, auto-dismisses it, and skips OS reminders', async () => {
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
        notifyMock.mockClear();
        nativeMock.window.setTrayBadgeCount.mockClear();

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)?.({
            sessionId: 1,
            taskId: 'task-1',
            status: 'completed',
            previousStatus: 'running',
        });
        await flushLifecycle();

        expect(mounted.result.statusReminderOverlay.value).toEqual({
            id: 1,
            kind: 'completed',
            content: getSessionStatusReminderContent('completed'),
        });
        expect(notifyMock).not.toHaveBeenCalled();
        expect(nativeMock.window.setTrayBadgeCount).not.toHaveBeenCalled();

        vi.advanceTimersByTime(3_200);
        await flushLifecycle();

        expect(mounted.result.statusReminderOverlay.value).toBeNull();

        mounted.unmount();
    });

    it('clears the foreground status overlay when the window loses focus or becomes hidden', async () => {
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

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)?.({
            sessionId: 1,
            taskId: 'task-1',
            status: 'waiting_approval',
            previousStatus: 'running',
        });
        await flushLifecycle();

        expect(mounted.result.statusReminderOverlay.value?.kind).toBe('waiting_approval');

        window.dispatchEvent(new Event('blur'));
        await flushLifecycle();

        expect(mounted.result.statusReminderOverlay.value).toBeNull();

        window.dispatchEvent(new Event('focus'));
        await flushLifecycle();

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)?.({
            sessionId: 1,
            taskId: 'task-1',
            status: 'failed',
            previousStatus: 'running',
        });
        await flushLifecycle();

        expect(mounted.result.statusReminderOverlay.value?.kind).toBe('failed');

        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));
        await flushLifecycle();

        expect(mounted.result.statusReminderOverlay.value).toBeNull();

        mounted.unmount();
    });

    it('keeps status reminders in-app when the search surface is visible but unfocused', async () => {
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
        notifyMock.mockClear();
        nativeMock.window.setTrayBadgeCount.mockClear();

        window.dispatchEvent(new Event('blur'));
        await flushLifecycle();

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)?.({
            sessionId: 1,
            taskId: 'task-1',
            status: 'completed',
            previousStatus: 'running',
        });
        await flushLifecycle();

        expect(mounted.result.statusReminderOverlay.value).toEqual({
            id: 1,
            kind: 'completed',
            content: getSessionStatusReminderContent('completed'),
        });
        expect(notifyMock).not.toHaveBeenCalled();
        expect(nativeMock.window.setTrayBadgeCount).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('restores the search surface from a notification without running shortcut auto-paste', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
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
                clearSession: vi.fn(),
                reconcilePopupSurfaces: vi.fn().mockResolvedValue(undefined),
                handleShortcutAutoPaste,
            })
        );

        await flushLifecycle();

        interactionContext.markWindowHidden({
            hideReason: 'manual-dismiss',
            hiddenAt: Date.now(),
        });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'notification',
            sequence: 1,
        });
        await flushLifecycle();

        expect(controller.focusSearchInput).toHaveBeenCalledTimes(1);
        expect(controller.loadActiveModel).toHaveBeenCalledTimes(1);
        expect(syncWindowPinState).toHaveBeenCalledTimes(2);
        expect(handleShortcutAutoPaste).not.toHaveBeenCalled();
        expect(interactionContext.state.activationSource).toBe('manual');

        mounted.unmount();
    });

    it('sends one OS notification per hidden status change and clears the tray badge when shown again', async () => {
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
        notifyMock.mockClear();
        nativeMock.window.clearTrayBadge.mockClear();
        nativeMock.window.setTrayBadgeCount.mockClear();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)?.({
            sequence: 1,
            reason: 'manual-dismiss',
        });
        await flushLifecycle();
        expect(interactionContext.state.windowVisible).toBe(false);

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)?.({
            sessionId: 1,
            taskId: 'task-1',
            status: 'waiting_approval',
            previousStatus: 'running',
        });
        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)?.({
            sessionId: 1,
            taskId: 'task-1',
            status: 'failed',
            previousStatus: 'waiting_approval',
        });
        await flushLifecycle();

        expect(notifyMock).toHaveBeenNthCalledWith(
            1,
            {
                title: 'TouchAI',
                body: getSessionStatusReminderContent('waiting_approval'),
            },
            {
                trackAsStatusReminder: true,
            }
        );
        expect(notifyMock).toHaveBeenNthCalledWith(
            2,
            {
                title: 'TouchAI',
                body: getSessionStatusReminderContent('failed'),
            },
            {
                trackAsStatusReminder: true,
            }
        );
        expect(nativeMock.window.setTrayBadgeCount).toHaveBeenNthCalledWith(1, 1);
        expect(nativeMock.window.setTrayBadgeCount).toHaveBeenNthCalledWith(2, 2);

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({ sequence: 2 });
        await flushLifecycle();

        expect(nativeMock.window.clearTrayBadge).toHaveBeenCalled();
        expect(clearStatusReminderNotificationsMock).toHaveBeenCalled();

        mounted.unmount();
    });

    it('clears reminder badges and tracked notifications when the window regains focus', async () => {
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
        notifyMock.mockClear();
        nativeMock.window.setTrayBadgeCount.mockClear();
        nativeMock.window.clearTrayBadge.mockClear();
        clearStatusReminderNotificationsMock.mockClear();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)?.({
            sequence: 1,
            reason: 'manual-dismiss',
        });
        await flushLifecycle();

        window.dispatchEvent(new Event('blur'));
        await flushLifecycle();

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)?.({
            sessionId: 1,
            taskId: 'task-1',
            status: 'completed',
            previousStatus: 'running',
        });
        await flushLifecycle();

        expect(nativeMock.window.setTrayBadgeCount).toHaveBeenCalledWith(1);
        expect(clearStatusReminderNotificationsMock).not.toHaveBeenCalled();

        const callsBeforeFocus = clearStatusReminderNotificationsMock.mock.calls.length;

        window.dispatchEvent(new Event('focus'));
        await flushLifecycle();

        expect(interactionContext.state.windowVisible).toBe(true);
        expect(nativeMock.window.clearTrayBadge).toHaveBeenCalled();
        expect(clearStatusReminderNotificationsMock.mock.calls.length).toBeGreaterThan(
            callsBeforeFocus
        );

        mounted.unmount();
    });
});
