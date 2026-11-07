import { AppEvent } from '@services/EventService';
import type { SearchSurfaceShownEvent } from '@services/EventService/types';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { createSearchInteractionContext } from '@/views/SearchView/composables/searchInteraction';
import {
    useSearchPageController,
    useSearchPageLifecycle,
    useSearchWindowPin,
} from '@/views/SearchView/composables/useSearchPage';

const {
    currentWindowMock,
    eventHandlers,
    eventServiceMock,
    initNotificationPermissionMock,
    nativeMock,
    notifyMock,
    runStartupTasksMock,
    settingsStoreMock,
    useAlertMock,
} = vi.hoisted(() => {
    const handlers = new Map<string, (payload?: unknown) => unknown>();

    return {
        currentWindowMock: {
            isVisible: vi.fn(),
            isFocused: vi.fn(),
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
                reconcileSearchWindowBlur: vi.fn(),
                setTrayStatusIndicator: vi.fn(),
                clearTrayStatusIndicator: vi.fn(),
                showSessionStatusReminderNotification: vi.fn(),
                clearSessionStatusReminderNotifications: vi.fn(),
                setSearchSurfaceHideOnAppBlur: vi.fn(),
            },
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
        settleQuickSearchInteraction: vi.fn(),
    };
}

function createShownEvent(
    sequence: number,
    source: SearchSurfaceShownEvent['source'] = 'notification'
): SearchSurfaceShownEvent {
    return {
        source,
        sequence,
        rendererEpoch: 2,
        showEpoch: sequence,
        hostEpoch: sequence + 10,
        generation: sequence + 20,
    };
}

describe('useSearchPageController', () => {
    it('user sees the panel close and the search state cleared', () => {
        const quickSearchOpen = ref(true);
        const closeQuickSearchPanel = vi.fn(() => {
            quickSearchOpen.value = false;
        });
        const quickSearchPanel = ref({
            open: vi.fn(),
            close: closeQuickSearchPanel,
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

    it('user still gets the panel closed when it has not been mounted yet', () => {
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
        approval: {
            callId: string;
            approveLabel: string;
            rejectLabel: string;
        } | null;
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
                overrides.approval !== undefined
                    ? overrides.approval
                    : kind === 'waiting_approval'
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
        currentWindowMock.isFocused.mockResolvedValue(false);
        currentWindowMock.isAlwaysOnTop.mockResolvedValue(false);
        currentWindowMock.setAlwaysOnTop.mockResolvedValue(undefined);

        nativeMock.shortcut.registerGlobalShortcut.mockResolvedValue(undefined);
        nativeMock.runtime.getRuntimeInfo.mockResolvedValue({ isE2eTestMode: false });
        nativeMock.window.hideSearchWindow.mockResolvedValue(undefined);
        nativeMock.window.reconcileSearchWindowBlur.mockResolvedValue(undefined);
        nativeMock.window.setTrayStatusIndicator.mockResolvedValue(undefined);
        nativeMock.window.clearTrayStatusIndicator.mockResolvedValue(undefined);
        nativeMock.window.showSessionStatusReminderNotification.mockResolvedValue(undefined);
        nativeMock.window.clearSessionStatusReminderNotifications.mockResolvedValue(undefined);
        nativeMock.window.setSearchSurfaceHideOnAppBlur.mockResolvedValue(undefined);

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
        expect(currentWindowMock.isVisible).toHaveBeenCalledTimes(1);
        expect(syncWindowPinState).toHaveBeenCalledTimes(1);

        isPinned.value = true;
        await nextTick();

        expect(nativeMock.window.setSearchSurfaceHideOnAppBlur).toHaveBeenLastCalledWith(false);

        mounted.unmount();
    });

    it('user keeps a pinned window visible when blur arrives before pin readback completes', async () => {
        let nativePinned = false;
        let visible = true;
        let readback!: (value: boolean) => void;
        currentWindowMock.isAlwaysOnTop.mockImplementation(() =>
            nativePinned
                ? new Promise<boolean>((resolve) => {
                      readback = resolve;
                  })
                : Promise.resolve(false)
        );
        currentWindowMock.setAlwaysOnTop.mockImplementation(async (pinned) => {
            nativePinned = pinned;
        });
        nativeMock.window.hideSearchWindow.mockImplementation(async () => {
            visible = false;
        });
        nativeMock.window.reconcileSearchWindowBlur.mockImplementation(async () => {
            if (!nativePinned) visible = false;
        });
        const mounted = await mountComposable(() => {
            const pin = useSearchWindowPin();
            useSearchPageLifecycle({
                controller: createController() as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: pin.isPinned,
                interactionContext: createSearchInteractionContext(),
                syncWindowPinState: pin.syncWindowPinState,
                clearSession: vi.fn(),
            });
            return pin;
        });
        await flushLifecycle();
        const toggle = mounted.result.toggleWindowPin();
        await flushLifecycle();
        expect(nativePinned).toBe(true);
        expect(mounted.result.isPinned.value).toBe(false);
        window.dispatchEvent(new Event('blur'));
        await vi.advanceTimersByTimeAsync(50);
        const visibleDuringReadback = visible;
        readback(true);
        await toggle;
        mounted.unmount();
        expect(visibleDuringReadback).toBe(true);
    });

    it('user closes the view during listener registration without leaving active subscriptions', async () => {
        let finishRegistration!: () => void;
        const registration = new Promise<void>((resolve) => {
            finishRegistration = resolve;
        });
        eventServiceMock.on.mockImplementationOnce(async (event, handler) => {
            await registration;
            eventHandlers.set(event, handler);
            return () => {
                eventHandlers.delete(event);
            };
        });
        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: createController() as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext: createSearchInteractionContext(),
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
            })
        );
        await flushLifecycle();
        mounted.unmount();
        finishRegistration();
        await flushLifecycle();

        expect(eventHandlers.size).toBe(0);
        expect(runStartupTasksMock).not.toHaveBeenCalled();
    });

    it.each(['refocus', 'unmount'] as const)(
        'user keeps the current view when an obsolete blur check finishes after %s',
        async (action) => {
            let finishFocusCheck!: (focused: boolean) => void;
            currentWindowMock.isFocused.mockReturnValueOnce(
                new Promise<boolean>((resolve) => {
                    finishFocusCheck = resolve;
                })
            );
            const reconcileSearchOverlays = vi.fn().mockResolvedValue(undefined);
            const mounted = await mountComposable(() =>
                useSearchPageLifecycle({
                    controller: createController() as never,
                    viewReady: ref(true),
                    isDragging: ref(false),
                    isPinned: ref(false),
                    interactionContext: createSearchInteractionContext(),
                    syncWindowPinState: vi.fn().mockResolvedValue(false),
                    clearSession: vi.fn(),
                    reconcileSearchOverlays,
                })
            );
            await flushLifecycle();
            window.dispatchEvent(new Event('blur'));
            await vi.advanceTimersByTimeAsync(50);

            if (action === 'refocus') window.dispatchEvent(new Event('focus'));
            else mounted.unmount();
            finishFocusCheck(false);
            await flushLifecycle();
            if (action === 'refocus') mounted.unmount();

            expect(reconcileSearchOverlays).not.toHaveBeenCalled();
            expect(nativeMock.window.hideSearchWindow).not.toHaveBeenCalled();
        }
    );

    it.each(['refocus', 'shown', 'unmount', 'pin', 'drag', 'maximize'] as const)(
        'ignores a pending interaction-end hide after %s',
        async (action) => {
            const isDragging = ref(false);
            const isPinned = ref(false);
            const isMaximized = ref(false);
            const mounted = await mountComposable(() =>
                useSearchPageLifecycle({
                    controller: createController() as never,
                    viewReady: ref(true),
                    isDragging,
                    isPinned,
                    isMaximized,
                    interactionContext: createSearchInteractionContext(),
                    syncWindowPinState: vi.fn().mockResolvedValue(false),
                    clearSession: vi.fn(),
                })
            );
            await flushLifecycle();
            isDragging.value = true;
            await flushLifecycle();
            window.dispatchEvent(new Event('blur'));
            let finishPolicy!: () => void;
            nativeMock.window.setSearchSurfaceHideOnAppBlur.mockReturnValueOnce(
                new Promise<void>((resolve) => {
                    finishPolicy = resolve;
                })
            );
            isDragging.value = false;
            await flushLifecycle();

            if (action === 'refocus') window.dispatchEvent(new Event('focus'));
            else if (action === 'shown')
                await mounted.result.handleSearchSurfaceShown(createShownEvent(1));
            else if (action === 'unmount') mounted.unmount();
            else if (action === 'pin') isPinned.value = true;
            else if (action === 'drag') isDragging.value = true;
            else isMaximized.value = true;
            finishPolicy();
            await flushLifecycle();
            if (action !== 'unmount') mounted.unmount();

            expect(nativeMock.window.hideSearchWindow).not.toHaveBeenCalled();
        }
    );

    it('keeps app-blur hiding disabled during panel interaction and hides after Alt+Tab blur', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
        const isDragging = ref(false);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging,
                isPinned: ref(false),
                isMaximized: ref(false),
                interactionContext,
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
            })
        );

        await flushLifecycle();
        nativeMock.window.setSearchSurfaceHideOnAppBlur.mockClear();
        nativeMock.window.hideSearchWindow.mockClear();

        isDragging.value = true;
        await nextTick();
        expect(nativeMock.window.setSearchSurfaceHideOnAppBlur).toHaveBeenLastCalledWith(false);
        expect(nativeMock.window.hideSearchWindow).not.toHaveBeenCalled();

        window.dispatchEvent(new Event('blur'));
        expect(interactionContext.state.windowFocused).toBe(false);

        isDragging.value = false;
        await flushLifecycle();

        expect(nativeMock.window.setSearchSurfaceHideOnAppBlur).toHaveBeenLastCalledWith(true);
        expect(nativeMock.window.reconcileSearchWindowBlur).toHaveBeenCalledTimes(1);
        expect(nativeMock.window.hideSearchWindow).not.toHaveBeenCalled();

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
                title: '任务已完成',
                body: 'done',
            })
        );
        await flushLifecycle();

        expect(nativeMock.window.showSessionStatusReminderNotification).toHaveBeenCalledWith({
            title: '任务已完成',
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

    it('dismisses overlays without restoring focus when a pinned surface loses focus', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
        const reconcileSearchOverlays = vi.fn().mockResolvedValue(undefined);
        const documentHasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(true),
                interactionContext,
                syncWindowPinState: vi.fn().mockResolvedValue(true),
                clearSession: vi.fn(),
                reconcileSearchOverlays,
            })
        );

        await flushLifecycle();
        reconcileSearchOverlays.mockClear();

        window.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(50);
        await flushLifecycle();

        expect(reconcileSearchOverlays).toHaveBeenCalledWith(false);
        expect(controller.focusSearchInput).not.toHaveBeenCalled();

        documentHasFocus.mockRestore();
        mounted.unmount();
    });

    it('keeps overlays open when native host resizing briefly blurs and refocuses the WebView', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
        const reconcileSearchOverlays = vi.fn().mockResolvedValue(undefined);
        const documentHasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(true),
                interactionContext,
                syncWindowPinState: vi.fn().mockResolvedValue(true),
                clearSession: vi.fn(),
                reconcileSearchOverlays,
            })
        );

        await flushLifecycle();
        reconcileSearchOverlays.mockClear();

        window.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(10);
        window.dispatchEvent(new Event('focus'));
        vi.advanceTimersByTime(50);
        await flushLifecycle();

        expect(reconcileSearchOverlays).not.toHaveBeenCalled();

        documentHasFocus.mockRestore();
        mounted.unmount();
    });

    it('keeps overlays open when WebView blur leaves the native window focused', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
        const reconcileSearchOverlays = vi.fn().mockResolvedValue(undefined);
        const documentHasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        currentWindowMock.isFocused.mockResolvedValue(true);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(true),
                interactionContext,
                syncWindowPinState: vi.fn().mockResolvedValue(true),
                clearSession: vi.fn(),
                reconcileSearchOverlays,
            })
        );

        await flushLifecycle();
        reconcileSearchOverlays.mockClear();

        window.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(50);
        await flushLifecycle();

        expect(currentWindowMock.isFocused).toHaveBeenCalledTimes(1);
        expect(reconcileSearchOverlays).not.toHaveBeenCalled();

        documentHasFocus.mockRestore();
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
        const surfaceHiddenHandler = mounted.result.handleSearchSurfaceHidden;
        await surfaceHiddenHandler({
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
        const surfaceHiddenHandler = mounted.result.handleSearchSurfaceHidden;
        await surfaceHiddenHandler({
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

        const surfaceShownHandler = mounted.result.handleSearchSurfaceShown;
        await surfaceShownHandler(createShownEvent(2));
        await flushLifecycle();

        expect(nativeMock.window.clearTrayStatusIndicator).toHaveBeenCalled();
        expect(nativeMock.window.clearSessionStatusReminderNotifications).toHaveBeenCalled();

        mounted.unmount();
    });

    it('adds an open action for waiting reminders that have no approval buttons', async () => {
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
        const surfaceHiddenHandler = mounted.result.handleSearchSurfaceHidden;
        await surfaceHiddenHandler({
            sequence: 1,
            reason: 'manual-dismiss',
        });
        await flushLifecycle();

        const statusHandler = eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED);
        expect(statusHandler).toBeDefined();
        await statusHandler!(
            createStatusChangedPayload('waiting_approval', {
                title: 'Waiting for response',
                body: 'Pick the deployment target',
                approval: null,
            })
        );
        await flushLifecycle();

        expect(nativeMock.window.showSessionStatusReminderNotification).toHaveBeenCalledWith({
            title: 'Waiting for response',
            body: 'Pick the deployment target',
            sessionId: 1,
            taskId: 'task-1',
            kind: 'waiting_approval',
            approval: null,
            openLabel: '打开',
        });
        expect(nativeMock.window.setTrayStatusIndicator).toHaveBeenCalledWith('waiting_approval');

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

    it('ignores stale surface shown events after a newer hidden event', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
        const clearSession = vi.fn().mockResolvedValue(undefined);
        const reconcileSearchOverlays = vi.fn().mockResolvedValue(undefined);
        const handleShortcutAutoPaste = vi.fn().mockResolvedValue(undefined);
        const syncWindowPinState = vi.fn().mockResolvedValue(false);
        const acceptedVisibility: boolean[] = [];

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext,
                syncWindowPinState,
                onSurfaceVisibilityChange: (visible) => {
                    acceptedVisibility.push(visible);
                },
                clearSession,
                reconcileSearchOverlays,
                handleShortcutAutoPaste,
            })
        );

        await flushLifecycle();

        const surfaceShownHandler = mounted.result.handleSearchSurfaceShown;
        const surfaceHiddenHandler = mounted.result.handleSearchSurfaceHidden;

        await surfaceShownHandler(createShownEvent(2, 'shortcut'));
        await flushLifecycle();
        await surfaceHiddenHandler({ sequence: 3, reason: 'manual-dismiss' });
        await flushLifecycle();

        expect(interactionContext.state.windowVisible).toBe(false);
        expect(acceptedVisibility).toEqual([true, false]);

        controller.focusSearchInput.mockClear();
        controller.loadActiveModel.mockClear();
        clearSession.mockClear();
        reconcileSearchOverlays.mockClear();
        handleShortcutAutoPaste.mockClear();
        syncWindowPinState.mockClear();

        await surfaceShownHandler(createShownEvent(2, 'shortcut'));
        await flushLifecycle();

        expect(interactionContext.state.windowVisible).toBe(false);
        expect(controller.focusSearchInput).not.toHaveBeenCalled();
        expect(controller.loadActiveModel).not.toHaveBeenCalled();
        expect(clearSession).not.toHaveBeenCalled();
        expect(reconcileSearchOverlays).not.toHaveBeenCalled();
        expect(handleShortcutAutoPaste).not.toHaveBeenCalled();
        expect(syncWindowPinState).not.toHaveBeenCalled();

        await surfaceShownHandler(createShownEvent(4));
        await surfaceHiddenHandler({ sequence: 3, reason: 'manual-dismiss' });
        expect(interactionContext.state.windowVisible).toBe(true);
        expect(acceptedVisibility).toEqual([true, false, true]);

        mounted.unmount();
    });

    it('cancels in-flight surface activation when a newer hidden event arrives', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
        const clearSession = vi.fn().mockResolvedValue(undefined);
        const handleShortcutAutoPaste = vi.fn().mockResolvedValue(undefined);
        const syncWindowPinState = vi.fn().mockResolvedValue(false);
        const remeasureSearchWindowHeight = vi.fn().mockResolvedValue(undefined);

        let resolveOverlayReconciliation!: () => void;
        const overlayReconciliationPending = new Promise<void>((resolve) => {
            resolveOverlayReconciliation = resolve;
        });
        const reconcileSearchOverlays = vi.fn(() => overlayReconciliationPending);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext,
                syncWindowPinState,
                clearSession,
                reconcileSearchOverlays,
                remeasureSearchWindowHeight,
                handleShortcutAutoPaste,
            })
        );

        await flushLifecycle();
        controller.focusSearchInput.mockClear();
        controller.loadActiveModel.mockClear();
        syncWindowPinState.mockClear();
        remeasureSearchWindowHeight.mockClear();
        handleShortcutAutoPaste.mockClear();

        const shownPromise = mounted.result.handleSearchSurfaceShown(
            createShownEvent(1, 'shortcut')
        );
        await flushLifecycle();
        expect(reconcileSearchOverlays).toHaveBeenCalledTimes(1);

        await mounted.result.handleSearchSurfaceHidden({
            sequence: 2,
            reason: 'manual-dismiss',
        });
        resolveOverlayReconciliation();
        await shownPromise;
        await flushLifecycle();

        expect(interactionContext.state.windowVisible).toBe(false);
        expect(controller.focusSearchInput).not.toHaveBeenCalled();
        expect(controller.loadActiveModel).not.toHaveBeenCalled();
        expect(syncWindowPinState).not.toHaveBeenCalled();
        expect(remeasureSearchWindowHeight).not.toHaveBeenCalled();
        expect(handleShortcutAutoPaste).not.toHaveBeenCalled();
        expect(clearSession).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('cancels in-flight surface activation when the lifecycle unmounts', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
        const clearSession = vi.fn().mockResolvedValue(undefined);
        const handleShortcutAutoPaste = vi.fn().mockResolvedValue(undefined);
        const syncWindowPinState = vi.fn().mockResolvedValue(false);
        const remeasureSearchWindowHeight = vi.fn().mockResolvedValue(undefined);

        let resolveOverlayReconciliation!: () => void;
        const overlayReconciliationPending = new Promise<void>((resolve) => {
            resolveOverlayReconciliation = resolve;
        });
        const reconcileSearchOverlays = vi.fn(() => overlayReconciliationPending);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext,
                syncWindowPinState,
                clearSession,
                reconcileSearchOverlays,
                remeasureSearchWindowHeight,
                handleShortcutAutoPaste,
            })
        );

        await flushLifecycle();
        controller.focusSearchInput.mockClear();
        controller.loadActiveModel.mockClear();
        syncWindowPinState.mockClear();
        remeasureSearchWindowHeight.mockClear();
        handleShortcutAutoPaste.mockClear();

        const shownPromise = mounted.result.handleSearchSurfaceShown(
            createShownEvent(1, 'shortcut')
        );
        await flushLifecycle();
        expect(reconcileSearchOverlays).toHaveBeenCalledTimes(1);

        mounted.unmount();
        resolveOverlayReconciliation();
        await shownPromise;
        await flushLifecycle();

        expect(controller.focusSearchInput).not.toHaveBeenCalled();
        expect(controller.loadActiveModel).not.toHaveBeenCalled();
        expect(syncWindowPinState).not.toHaveBeenCalled();
        expect(remeasureSearchWindowHeight).not.toHaveBeenCalled();
        expect(handleShortcutAutoPaste).not.toHaveBeenCalled();
        expect(clearSession).not.toHaveBeenCalled();
    });

    it('clears timed-out sessions when the search surface is reopened after manual dismiss', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
        const clearSession = vi.fn().mockResolvedValue(undefined);
        const reconcileSearchOverlays = vi.fn().mockResolvedValue(undefined);
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
                reconcileSearchOverlays,
                handleShortcutAutoPaste,
            })
        );

        await flushLifecycle();

        interactionContext.markWindowHidden({
            hideReason: 'manual-dismiss',
            hiddenAt: Date.now() - 5 * 60 * 1000 - 1,
        });

        await mounted.result.handleSearchSurfaceShown(createShownEvent(1, 'shortcut'));
        await flushLifecycle();

        expect(clearSession).toHaveBeenCalledTimes(1);
        expect(reconcileSearchOverlays).toHaveBeenCalledTimes(1);
        expect(controller.focusSearchInput).toHaveBeenCalledTimes(1);
        expect(controller.loadActiveModel).toHaveBeenCalledTimes(1);
        expect(syncWindowPinState).toHaveBeenCalledTimes(2);
        expect(handleShortcutAutoPaste).toHaveBeenCalledTimes(1);
        expect(interactionContext.state.lastHideReason).toBe('manual-dismiss');

        mounted.unmount();
    });

    it('suppresses timed-out session clearing when the page policy says auto-shrink is not yet allowed', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
        const clearSession = vi.fn().mockResolvedValue(undefined);
        const reconcileSearchOverlays = vi.fn().mockResolvedValue(undefined);
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
                shouldClearSessionAfterTimeout: () => false,
                reconcileSearchOverlays,
                handleShortcutAutoPaste,
            })
        );

        await flushLifecycle();

        interactionContext.markWindowHidden({
            hideReason: 'app-blur-hide',
            hiddenAt: Date.now() - 5 * 60 * 1000 - 1,
        });

        await mounted.result.handleSearchSurfaceShown(createShownEvent(1, 'shortcut'));
        await flushLifecycle();

        expect(clearSession).not.toHaveBeenCalled();
        expect(reconcileSearchOverlays).toHaveBeenCalledTimes(1);
        expect(controller.focusSearchInput).toHaveBeenCalledTimes(1);
        expect(controller.loadActiveModel).toHaveBeenCalledTimes(1);
        expect(syncWindowPinState).toHaveBeenCalledTimes(2);
        expect(handleShortcutAutoPaste).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });

    it('remeasures the search window height when a hidden completed session is reopened', async () => {
        const controller = createController();
        const interactionContext = createSearchInteractionContext();
        const clearSession = vi.fn().mockResolvedValue(undefined);
        const reconcileSearchOverlays = vi.fn().mockResolvedValue(undefined);
        const handleShortcutAutoPaste = vi.fn().mockResolvedValue(undefined);
        const syncWindowPinState = vi.fn().mockResolvedValue(false);
        const remeasureSearchWindowHeight = vi.fn().mockResolvedValue(undefined);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: controller as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext,
                syncWindowPinState,
                clearSession,
                shouldClearSessionAfterTimeout: () => false,
                reconcileSearchOverlays,
                handleShortcutAutoPaste,
                remeasureSearchWindowHeight,
            })
        );

        await flushLifecycle();

        const surfaceHiddenHandler = mounted.result.handleSearchSurfaceHidden;
        const statusHandler = eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED);
        const surfaceShownHandler = mounted.result.handleSearchSurfaceShown;
        expect(statusHandler).toBeDefined();

        await surfaceHiddenHandler({
            sequence: 1,
            reason: 'app-blur-hide',
        });
        await flushLifecycle();
        await statusHandler!(createStatusChangedPayload('completed'));
        await flushLifecycle();

        remeasureSearchWindowHeight.mockClear();

        await surfaceShownHandler(createShownEvent(2));
        await flushLifecycle();

        expect(remeasureSearchWindowHeight).toHaveBeenCalledTimes(1);
        expect(reconcileSearchOverlays).toHaveBeenCalledTimes(1);
        expect(controller.focusSearchInput).toHaveBeenCalledTimes(1);
        expect(controller.loadActiveModel).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });
});
