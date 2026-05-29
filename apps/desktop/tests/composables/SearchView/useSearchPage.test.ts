import { AppEvent } from '@services/EventService';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { createSearchInteractionContext } from '@/views/SearchView/composables/searchInteraction';
import {
    useSearchPageController,
    useSearchPageLifecycle,
} from '@/views/SearchView/composables/useSearchPage';

const {
    currentWindowMock,
    eventHandlers,
    eventServiceMock,
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
                setTrayStatusIndicator: vi.fn(),
                clearTrayStatusIndicator: vi.fn(),
                showSessionStatusReminderNotification: vi.fn(),
                clearSessionStatusReminderNotifications: vi.fn(),
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

describe('useSearchPageController', () => {
    it('closes quick search through the panel so internal search state is cleared', () => {
        const quickSearchOpen = ref(true);
        const closeQuickSearchPanel = vi.fn(() => {
            quickSearchOpen.value = false;
        });
        const quickSearchPanel = ref({
            open: vi.fn(),
            close: closeQuickSearchPanel,
            syncClosedState: vi.fn(),
            moveSelection: vi.fn(),
            getHighlightedItem: vi.fn(() => null),
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
        });

        const controller = useSearchPageController({
            searchBar: ref(),
            quickSearchOpen,
            quickSearchPanel: quickSearchPanel as never,
            conversationPanel: ref(),
        });

        controller.closeQuickSearch();

        expect(closeQuickSearchPanel).toHaveBeenCalledTimes(1);
        expect(quickSearchOpen.value).toBe(false);
    });

    it('falls back to closing the quick search flag when the panel is not mounted', () => {
        const quickSearchOpen = ref(true);

        const controller = useSearchPageController({
            searchBar: ref(),
            quickSearchOpen,
            quickSearchPanel: ref(),
            conversationPanel: ref(),
        });

        controller.closeQuickSearch();

        expect(quickSearchOpen.value).toBe(false);
    });
});

function createStatusChangedPayload(
    kind: 'completed' | 'failed' | 'waiting_approval',
    overrides: Partial<{
        previousStatus: 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
        body: string;
        title: string;
    }> = {}
) {
    const defaultTitle =
        kind === 'completed' ? '任务已完成' : kind === 'failed' ? '任务失败' : '等待批准';

    return {
        sessionId: 1,
        taskId: 'task-1',
        status: kind,
        previousStatus: overrides.previousStatus ?? 'running',
        reminder: {
            kind,
            title: overrides.title ?? defaultTitle,
            body: overrides.body ?? `${kind} body`,
            approval:
                kind === 'waiting_approval'
                    ? {
                          callId: 'call-1',
                          approveLabel: 'Approve',
                          rejectLabel: 'Reject',
                      }
                    : null,
        },
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
        nativeMock.window.setTrayStatusIndicator.mockResolvedValue(undefined);
        nativeMock.window.clearTrayStatusIndicator.mockResolvedValue(undefined);
        nativeMock.window.showSessionStatusReminderNotification.mockResolvedValue(undefined);
        nativeMock.window.clearSessionStatusReminderNotifications.mockResolvedValue(undefined);
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
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('initializes the lifecycle and keeps the app-blur hide policy in sync', async () => {
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

    it('does not send status notifications while the search surface is visible', async () => {
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

        const statusHandler = eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED);
        expect(statusHandler).toBeDefined();
        await statusHandler!(createStatusChangedPayload('completed'));
        await flushLifecycle();

        expect(nativeMock.window.showSessionStatusReminderNotification).not.toHaveBeenCalled();
        expect(nativeMock.window.setTrayStatusIndicator).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('sends status notifications when the search surface is visible but the app is unfocused', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(true),
                interactionContext,
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
            })
        );

        await flushLifecycle();

        window.dispatchEvent(new Event('blur'));
        await flushLifecycle();

        const statusHandler = eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED);
        expect(statusHandler).toBeDefined();
        await statusHandler!(
            createStatusChangedPayload('completed', {
                title: '浠诲姟宸插畬鎴?',
                body: 'done',
            })
        );
        await flushLifecycle();

        expect(nativeMock.window.showSessionStatusReminderNotification).toHaveBeenCalledWith({
            title: '浠诲姟宸插畬鎴?',
            body: 'done',
            sessionId: 1,
            taskId: 'task-1',
            kind: 'completed',
            approval: null,
            openLabel: '打开',
        });
        expect(nativeMock.window.setTrayStatusIndicator).toHaveBeenCalledWith('completed');

        mounted.unmount();
    });

    it('sends background reminders through native notifications and tray status dots', async () => {
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
        const surfaceHiddenHandler = eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN);
        expect(surfaceHiddenHandler).toBeDefined();
        await surfaceHiddenHandler!({
            sequence: 1,
            reason: 'manual-dismiss',
        });
        await flushLifecycle();

        const statusHandler = eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED);
        expect(statusHandler).toBeDefined();
        await statusHandler!(
            createStatusChangedPayload('failed', {
                title: '任务失败',
                body: 'network error',
            })
        );
        await flushLifecycle();

        expect(nativeMock.window.showSessionStatusReminderNotification).toHaveBeenCalledWith({
            title: '任务失败',
            body: 'network error',
            sessionId: 1,
            taskId: 'task-1',
            kind: 'failed',
            approval: null,
            openLabel: '打开',
        });
        expect(nativeMock.window.setTrayStatusIndicator).toHaveBeenCalledWith('failed');

        mounted.unmount();
    });

    it('uses the approval reminder payload in background and clears reminders when shown again', async () => {
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
        const surfaceHiddenHandler = eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN);
        expect(surfaceHiddenHandler).toBeDefined();
        await surfaceHiddenHandler!({
            sequence: 1,
            reason: 'manual-dismiss',
        });
        await flushLifecycle();

        const statusHandler = eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED);
        expect(statusHandler).toBeDefined();
        await statusHandler!(
            createStatusChangedPayload('waiting_approval', {
                body: 'Need approval',
            })
        );
        await flushLifecycle();

        expect(nativeMock.window.showSessionStatusReminderNotification).toHaveBeenCalledWith({
            title: '等待批准',
            body: 'Need approval',
            sessionId: 1,
            taskId: 'task-1',
            kind: 'waiting_approval',
            approval: {
                callId: 'call-1',
                approveLabel: 'Approve',
                rejectLabel: 'Reject',
            },
        });
        expect(nativeMock.window.setTrayStatusIndicator).toHaveBeenCalledWith('waiting_approval');

        const surfaceShownHandler = eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN);
        expect(surfaceShownHandler).toBeDefined();
        await surfaceShownHandler!({
            source: 'notification',
            sequence: 2,
        });
        await flushLifecycle();

        expect(nativeMock.window.clearTrayStatusIndicator).toHaveBeenCalled();
        expect(nativeMock.window.clearSessionStatusReminderNotifications).toHaveBeenCalled();

        mounted.unmount();
    });

    it('clears reminders and delegates notification actions to the page handler', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
        const handleSessionStatusReminderAction = vi.fn().mockResolvedValue(undefined);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext,
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
                handleSessionStatusReminderAction,
            })
        );

        await flushLifecycle();

        const reminderActionHandler = eventHandlers.get(AppEvent.SESSION_STATUS_REMINDER_ACTION);
        expect(reminderActionHandler).toBeDefined();
        await reminderActionHandler!({
            sessionId: 1,
            taskId: 'task-1',
            kind: 'completed',
            action: 'reply',
            replyText: 'follow up',
        });
        await flushLifecycle();

        expect(nativeMock.window.clearTrayStatusIndicator).toHaveBeenCalled();
        expect(nativeMock.window.clearSessionStatusReminderNotifications).toHaveBeenCalled();
        expect(handleSessionStatusReminderAction).toHaveBeenCalledWith({
            sessionId: 1,
            taskId: 'task-1',
            kind: 'completed',
            action: 'reply',
            replyText: 'follow up',
        });

        mounted.unmount();
    });
});
