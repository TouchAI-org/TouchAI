import { AppEvent } from '@services/EventService';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

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
    notifySessionStatusReminderMock,
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
        notifySessionStatusReminderMock: vi.fn(),
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
    notifySessionStatusReminder: notifySessionStatusReminderMock,
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

function createStatusChangedPayload(
    kind: 'completed' | 'failed' | 'waiting_approval',
    overrides: Partial<{
        previousStatus: 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
        body: string;
        title: string;
    }> = {}
) {
    return {
        sessionId: 1,
        taskId: 'task-1',
        status: kind,
        previousStatus: overrides.previousStatus ?? 'running',
        reminder: {
            kind,
            title: overrides.title ?? `TouchAI - ${kind}`,
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

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)?.(
            createStatusChangedPayload('completed')
        );
        await flushLifecycle();

        expect(notifySessionStatusReminderMock).not.toHaveBeenCalled();
        expect(nativeMock.window.setTrayStatusIndicator).not.toHaveBeenCalled();

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
        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)?.({
            sequence: 1,
            reason: 'manual-dismiss',
        });
        await flushLifecycle();

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)?.(
            createStatusChangedPayload('failed', {
                title: 'TouchAI - failed',
                body: 'network error',
            })
        );
        await flushLifecycle();

        expect(notifySessionStatusReminderMock).toHaveBeenCalledWith({
            title: 'TouchAI - failed',
            body: 'network error',
            sessionId: 1,
            taskId: 'task-1',
            kind: 'failed',
            approval: null,
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
        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)?.({
            sequence: 1,
            reason: 'manual-dismiss',
        });
        await flushLifecycle();

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)?.(
            createStatusChangedPayload('waiting_approval', {
                body: 'Need approval',
            })
        );
        await flushLifecycle();

        expect(notifySessionStatusReminderMock).toHaveBeenCalledWith({
            title: 'TouchAI - waiting_approval',
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

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({
            source: 'notification',
            sequence: 2,
        });
        await flushLifecycle();

        expect(nativeMock.window.clearTrayStatusIndicator).toHaveBeenCalled();
        expect(clearStatusReminderNotificationsMock).toHaveBeenCalled();

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

        await eventHandlers.get(AppEvent.SESSION_STATUS_REMINDER_ACTION)?.({
            sessionId: 1,
            taskId: 'task-1',
            kind: 'completed',
            action: 'reply',
            replyText: 'follow up',
        });
        await flushLifecycle();

        expect(nativeMock.window.clearTrayStatusIndicator).toHaveBeenCalled();
        expect(clearStatusReminderNotificationsMock).toHaveBeenCalled();
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
