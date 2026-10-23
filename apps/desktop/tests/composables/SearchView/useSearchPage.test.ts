import { AppEvent } from '@services/EventService';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { createSearchInteractionContext } from '@/views/SearchView/composables/searchInteraction';
import {
    useSearchModelDropdownCoordinator,
    useSearchPageController,
    useSearchPageLifecycle,
} from '@/views/SearchView/composables/useSearchPage';

const {
    currentWindowMock,
    eventHandlers,
    eventServiceMock,
    initNotificationPermissionMock,
    modelDropdownPopupMock,
    nativeMock,
    notifyMock,
    popupManagerMock,
    popupManagerState,
    runStartupTasksMock,
    settingsStoreMock,
    useAlertMock,
    useModelDropdownPopupMock,
} = vi.hoisted(() => {
    const handlers = new Map<string, (payload?: unknown) => unknown>();
    const modelDropdownPopup = {
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
        modelDropdownPopupMock: modelDropdownPopup,
        notifyMock: vi.fn(),
        nativeMock: {
            runtime: {
                getRuntimeInfo: vi.fn(),
            },
            shortcut: {
                registerGlobalShortcut: vi.fn(),
                setSearchSurfaceShortcuts: vi.fn(),
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
        useModelDropdownPopupMock: vi.fn(() => modelDropdownPopup),
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

vi.mock('@/views/SearchView/composables/useModelDropdownPopup', () => ({
    useModelDropdownPopup: useModelDropdownPopupMock,
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
        isQuickSearchOpen: vi.fn(() => false),
    };
}

function createQuickSearchPanel(close: () => void) {
    return ref({
        open: vi.fn(),
        close: vi.fn(close),
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
}

describe('closing the quick search panel', () => {
    it('user sees the panel close and the search state cleared', () => {
        const quickSearchOpen = ref(true);
        const quickSearchPanel = createQuickSearchPanel(() => {
            quickSearchOpen.value = false;
        });

        const controller = useSearchPageController({
            searchBar: ref(),
            quickSearchOpen,
            quickSearchPanel: quickSearchPanel as never,
            conversationPanel: ref(),
        });

        controller.closeQuickSearch();

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

describe('when the model dropdown is open and the shortcut changes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        modelDropdownPopupMock.isOpen.value = true;
        useModelDropdownPopupMock.mockReturnValue(modelDropdownPopupMock);
    });

    it('user sees the shortcut hint in the open dropdown follow the new binding', async () => {
        const modelToggleShortcut = ref<string | null>('Mod+M');
        const controller = {
            getModelDropdownAnchor: vi.fn(() => document.createElement('button')),
            getModelDropdownContext: vi.fn(() => ({
                activeModelId: null,
                activeProviderId: null,
                selectedModelId: null,
                selectedProviderId: null,
                models: [],
            })),
            prepareModelDropdownOpen: vi.fn().mockResolvedValue(undefined),
            selectModelFromDropdown: vi.fn().mockResolvedValue({
                modelId: null,
                providerId: null,
            }),
        };

        const mounted = await mountComposable(() =>
            useSearchModelDropdownCoordinator({
                pageContainer: ref(null),
                controller: controller as never,
                modelOverride: ref({
                    modelId: null,
                    providerId: null,
                }),
                modelDropdownState: ref({
                    isOpen: true,
                }),
                modelDropdownQuery: ref(''),
                getModelToggleShortcut: () => modelToggleShortcut.value,
                requestModelDropdownOpen: vi.fn(() => 'noop' as const),
                handleQuickSearchClosedForModelDropdown: vi.fn(() => 'noop' as const),
                handleLayoutStableForModelDropdown: vi.fn(() => 'noop' as const),
                handleModelDropdownOpened: vi.fn(),
                handleModelDropdownClosed: vi.fn(),
                syncOverlayState: vi.fn(),
            })
        );

        const popupOptions = (
            useModelDropdownPopupMock.mock.calls as unknown as Array<
                [
                    {
                        getPopupData: () => {
                            toggleShortcut?: string | null;
                        };
                    },
                ]
            >
        )[0]?.[0];
        expect(popupOptions?.getPopupData().toggleShortcut).toBe('Mod+M');

        modelToggleShortcut.value = 'Alt+M';
        await flushLifecycle();

        expect(popupOptions?.getPopupData().toggleShortcut).toBe('Alt+M');

        mounted.unmount();
    });
});

describe('when the dropdown searches models', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        modelDropdownPopupMock.isOpen.value = true;
        useModelDropdownPopupMock.mockReturnValue(modelDropdownPopupMock);
    });

    it('user sees only models the query matches, best match first', async () => {
        const controller = {
            getModelDropdownAnchor: vi.fn(() => document.createElement('button')),
            getModelDropdownContext: vi.fn(() => ({
                activeModelId: null,
                activeProviderId: null,
                selectedModelId: null,
                selectedProviderId: null,
                models: [
                    {
                        id: 1,
                        model_id: 'claude-sonnet-4',
                        name: 'Claude Sonnet 4',
                        provider_id: 2,
                        provider_name: 'Anthropic',
                        provider_enabled: 1,
                        reasoning: 1,
                        tool_call: 1,
                        modalities: null,
                        attachment: 1,
                        open_weights: 0,
                    },
                    {
                        id: 2,
                        model_id: 'gpt-5',
                        name: 'GPT-5',
                        provider_id: 1,
                        provider_name: 'OpenAI',
                        provider_enabled: 1,
                        reasoning: 1,
                        tool_call: 1,
                        modalities: null,
                        attachment: 1,
                        open_weights: 0,
                    },
                    {
                        id: 3,
                        model_id: 'hidden-model',
                        name: 'Disabled Provider Model',
                        provider_id: 9,
                        provider_name: 'Disabled',
                        provider_enabled: 0,
                        reasoning: 0,
                        tool_call: 0,
                        modalities: null,
                        attachment: 0,
                        open_weights: 0,
                    },
                ],
            })),
            prepareModelDropdownOpen: vi.fn().mockResolvedValue(undefined),
            selectModelFromDropdown: vi.fn().mockResolvedValue({
                modelId: null,
                providerId: null,
            }),
        };
        const modelDropdownQuery = ref('sonnet');

        const mounted = await mountComposable(() =>
            useSearchModelDropdownCoordinator({
                pageContainer: ref(null),
                controller: controller as never,
                modelOverride: ref({ modelId: null, providerId: null }),
                modelDropdownState: ref({ isOpen: true }),
                modelDropdownQuery,
                requestModelDropdownOpen: vi.fn(() => 'noop' as const),
                handleQuickSearchClosedForModelDropdown: vi.fn(() => 'noop' as const),
                handleLayoutStableForModelDropdown: vi.fn(() => 'noop' as const),
                handleModelDropdownOpened: vi.fn(),
                handleModelDropdownClosed: vi.fn(),
                syncOverlayState: vi.fn(),
            })
        );

        const popupOptions = (
            useModelDropdownPopupMock.mock.calls as unknown as Array<
                [
                    {
                        getPopupData: () => {
                            models: Array<{ modelId: string }>;
                        };
                    },
                ]
            >
        )[0]?.[0];

        expect(popupOptions?.getPopupData().models.map((model) => model.modelId)).toEqual([
            'claude-sonnet-4',
        ]);

        mounted.unmount();
    });

    it('user never sees models from a disabled provider', async () => {
        const controller = {
            getModelDropdownAnchor: vi.fn(() => document.createElement('button')),
            getModelDropdownContext: vi.fn(() => ({
                activeModelId: null,
                activeProviderId: null,
                selectedModelId: null,
                selectedProviderId: null,
                models: [
                    {
                        id: 3,
                        model_id: 'hidden-model',
                        name: 'Disabled Provider Model',
                        provider_id: 9,
                        provider_name: 'Disabled',
                        provider_enabled: 0,
                        reasoning: 0,
                        tool_call: 0,
                        modalities: null,
                        attachment: 0,
                        open_weights: 0,
                    },
                ],
            })),
            prepareModelDropdownOpen: vi.fn().mockResolvedValue(undefined),
            selectModelFromDropdown: vi.fn().mockResolvedValue({
                modelId: null,
                providerId: null,
            }),
        };

        const mounted = await mountComposable(() =>
            useSearchModelDropdownCoordinator({
                pageContainer: ref(null),
                controller: controller as never,
                modelOverride: ref({ modelId: null, providerId: null }),
                modelDropdownState: ref({ isOpen: true }),
                modelDropdownQuery: ref(''),
                requestModelDropdownOpen: vi.fn(() => 'noop' as const),
                handleQuickSearchClosedForModelDropdown: vi.fn(() => 'noop' as const),
                handleLayoutStableForModelDropdown: vi.fn(() => 'noop' as const),
                handleModelDropdownOpened: vi.fn(),
                handleModelDropdownClosed: vi.fn(),
                syncOverlayState: vi.fn(),
            })
        );

        const popupOptions = (
            useModelDropdownPopupMock.mock.calls as unknown as Array<
                [
                    {
                        getPopupData: () => {
                            models: unknown[];
                        };
                    },
                ]
            >
        )[0]?.[0];

        expect(popupOptions?.getPopupData().models).toEqual([]);

        mounted.unmount();
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

async function mountLifecycle(options: Partial<Parameters<typeof useSearchPageLifecycle>[0]> = {}) {
    const controller = options.controller ?? (createController() as never);
    const interactionContext = options.interactionContext ?? createSearchInteractionContext();

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

describe('when the search view starts up', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        eventHandlers.clear();
        modelDropdownPopupMock.isOpen.value = true;
        useModelDropdownPopupMock.mockReturnValue(modelDropdownPopupMock);

        currentWindowMock.isVisible.mockResolvedValue(true);
        currentWindowMock.isAlwaysOnTop.mockResolvedValue(false);
        currentWindowMock.setAlwaysOnTop.mockResolvedValue(undefined);

        nativeMock.shortcut.registerGlobalShortcut.mockResolvedValue(undefined);
        nativeMock.shortcut.setSearchSurfaceShortcuts.mockResolvedValue(undefined);
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

    it('user gets the app-blur hide policy switched off while the window is pinned', async () => {
        const isPinned = ref(false);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: createController() as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned,
                interactionContext: createSearchInteractionContext(),
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
            })
        );

        expect(nativeMock.window.setSearchSurfaceHideOnAppBlur).toHaveBeenLastCalledWith(true);

        isPinned.value = true;
        await nextTick();

        expect(nativeMock.window.setSearchSurfaceHideOnAppBlur).toHaveBeenLastCalledWith(false);

        mounted.unmount();
    });

    it('user gets the app-blur hide policy switched off while the window is being dragged or maximized', async () => {
        const isDragging = ref(false);
        const isMaximized = ref(false);

        const mounted = await mountComposable(() =>
            useSearchPageLifecycle({
                controller: createController() as never,
                viewReady: ref(true),
                isDragging,
                isPinned: ref(false),
                isMaximized,
                interactionContext: createSearchInteractionContext(),
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
            })
        );

        isDragging.value = true;
        await nextTick();
        expect(nativeMock.window.setSearchSurfaceHideOnAppBlur).toHaveBeenLastCalledWith(false);

        isDragging.value = false;
        isMaximized.value = true;
        await nextTick();
        expect(nativeMock.window.setSearchSurfaceHideOnAppBlur).toHaveBeenLastCalledWith(false);

        mounted.unmount();
    });

    it('user keeps the configured global shortcut registered and the popup layer ready', async () => {
        await mountLifecycle();

        expect(nativeMock.shortcut.registerGlobalShortcut).toHaveBeenCalledWith('Alt+Space');
        expect(popupManagerMock.initialize).toHaveBeenCalled();
    });

    it('user gets told when the global shortcut cannot be registered', async () => {
        nativeMock.shortcut.registerGlobalShortcut.mockRejectedValue(
            new Error('shortcut already registered')
        );

        await mountLifecycle();

        expect(notifyMock).toHaveBeenCalledWith(
            expect.objectContaining({
                title: expect.any(String),
                body: expect.any(String),
            })
        );
    });
});

describe('when the host window forwards a shortcut', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        eventHandlers.clear();
        currentWindowMock.isVisible.mockResolvedValue(true);
        currentWindowMock.isAlwaysOnTop.mockResolvedValue(false);
        nativeMock.shortcut.registerGlobalShortcut.mockResolvedValue(undefined);
        nativeMock.shortcut.setSearchSurfaceShortcuts.mockResolvedValue(undefined);
        nativeMock.runtime.getRuntimeInfo.mockResolvedValue({ isE2eTestMode: false });
        nativeMock.window.setSearchSurfaceHideOnAppBlur.mockResolvedValue(undefined);
        popupManagerMock.initialize.mockResolvedValue(undefined);
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

    it('user gets the command forwarded to the page only when the listener exists', async () => {
        const handleSearchSurfaceCommand = vi.fn().mockResolvedValue(undefined);

        await mountLifecycle({ handleSearchSurfaceCommand });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_COMMAND)!({
            actionId: 'search.model.toggle',
            shortcut: 'Mod+M',
            source: 'webview2-accelerator',
        });
        await flushLifecycle();

        expect(handleSearchSurfaceCommand).toHaveBeenCalledWith({
            actionId: 'search.model.toggle',
            shortcut: 'Mod+M',
            source: 'webview2-accelerator',
        });
    });

    it('user gets no command listener when the page does not handle shortcuts', async () => {
        await mountLifecycle();

        expect(eventHandlers.get(AppEvent.SEARCH_SURFACE_COMMAND)).toBeUndefined();
    });
});

describe('when the search surface is hidden and shown again', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        eventHandlers.clear();
        currentWindowMock.isVisible.mockResolvedValue(true);
        currentWindowMock.isAlwaysOnTop.mockResolvedValue(false);
        nativeMock.shortcut.registerGlobalShortcut.mockResolvedValue(undefined);
        nativeMock.shortcut.setSearchSurfaceShortcuts.mockResolvedValue(undefined);
        nativeMock.runtime.getRuntimeInfo.mockResolvedValue({ isE2eTestMode: false });
        nativeMock.window.setSearchSurfaceHideOnAppBlur.mockResolvedValue(undefined);
        nativeMock.window.showSessionStatusReminderNotification.mockResolvedValue(undefined);
        nativeMock.window.setTrayStatusIndicator.mockResolvedValue(undefined);
        nativeMock.window.clearTrayStatusIndicator.mockResolvedValue(undefined);
        nativeMock.window.clearSessionStatusReminderNotifications.mockResolvedValue(undefined);
        popupManagerMock.initialize.mockResolvedValue(undefined);
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

    it('user gets no reminder while the search surface is in the foreground', async () => {
        await mountLifecycle();

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)!(
            createStatusChangedPayload('completed')
        );
        await flushLifecycle();

        expect(nativeMock.window.showSessionStatusReminderNotification).not.toHaveBeenCalled();
        expect(nativeMock.window.setTrayStatusIndicator).not.toHaveBeenCalled();
    });

    it('user gets a desktop reminder and a tray dot when a hidden task completes', async () => {
        await mountLifecycle();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)!({
            sequence: 1,
            reason: 'manual-dismiss',
        });
        await flushLifecycle();

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)!(
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
    });

    it('user gets an actionable approval reminder while the task waits for approval', async () => {
        await mountLifecycle();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)!({
            sequence: 1,
            reason: 'manual-dismiss',
        });
        await flushLifecycle();

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)!(
            createStatusChangedPayload('waiting_approval', { body: 'Need approval' })
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
    });

    it('user gets an open action when the waiting task has no approval buttons', async () => {
        await mountLifecycle();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)!({
            sequence: 1,
            reason: 'manual-dismiss',
        });
        await flushLifecycle();

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)!(
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
    });

    it('user gets the reminder and tray dot cleared once the window is shown again', async () => {
        await mountLifecycle();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)!({
            sequence: 1,
            reason: 'manual-dismiss',
        });
        await flushLifecycle();
        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)!(
            createStatusChangedPayload('waiting_approval', { body: 'Need approval' })
        );
        await flushLifecycle();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)!({
            source: 'notification',
            sequence: 2,
        });
        await flushLifecycle();

        expect(nativeMock.window.clearTrayStatusIndicator).toHaveBeenCalled();
        expect(nativeMock.window.clearSessionStatusReminderNotifications).toHaveBeenCalled();
    });

    it('user gets the reminder action delegated to the page after the reminder is dismissed', async () => {
        const handleSessionStatusReminderAction = vi.fn().mockResolvedValue(undefined);
        await mountLifecycle({ handleSessionStatusReminderAction });

        await eventHandlers.get(AppEvent.SESSION_STATUS_REMINDER_ACTION)!({
            sessionId: 1,
            taskId: 'task-1',
            kind: 'completed',
            action: 'reply',
            replyText: 'follow up',
        });
        await flushLifecycle();

        expect(nativeMock.window.clearTrayStatusIndicator).toHaveBeenCalled();
        expect(handleSessionStatusReminderAction).toHaveBeenCalledWith({
            sessionId: 1,
            taskId: 'task-1',
            kind: 'completed',
            action: 'reply',
            replyText: 'follow up',
        });
    });

    it('user never sees a stale shown event undo a newer hide', async () => {
        const { controller, interactionContext } = await mountLifecycle({
            reconcilePopupSurfaces: vi.fn().mockResolvedValue(undefined),
            handleShortcutAutoPaste: vi.fn().mockResolvedValue(undefined),
        });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)!({
            source: 'shortcut',
            sequence: 2,
        });
        await flushLifecycle();
        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)!({
            sequence: 3,
            reason: 'manual-dismiss',
        });
        await flushLifecycle();

        expect(interactionContext.state.windowVisible).toBe(false);

        vi.mocked(controller.focusSearchInput).mockClear();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)!({
            source: 'shortcut',
            sequence: 2,
        });
        await flushLifecycle();

        expect(interactionContext.state.windowVisible).toBe(false);
        expect(controller.focusSearchInput).not.toHaveBeenCalled();
    });

    it('user gets the previous session cleared when reopening the window after the idle timeout', async () => {
        const clearSession = vi.fn().mockResolvedValue(undefined);
        const { controller, interactionContext } = await mountLifecycle({
            clearSession,
            reconcilePopupSurfaces: vi.fn().mockResolvedValue(undefined),
            handleShortcutAutoPaste: vi.fn().mockResolvedValue(undefined),
        });

        interactionContext.markWindowHidden({
            hideReason: 'manual-dismiss',
            hiddenAt: Date.now() - 5 * 60 * 1000 - 1,
        });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({ sequence: 1 });
        await flushLifecycle();

        expect(clearSession).toHaveBeenCalled();
        expect(controller.focusSearchInput).toHaveBeenCalled();
        expect(controller.loadActiveModel).toHaveBeenCalled();
        expect(interactionContext.state.lastHideReason).toBe('manual-dismiss');
    });

    it('user gets the previous session kept when the page policy blocks the timeout clear', async () => {
        const clearSession = vi.fn().mockResolvedValue(undefined);
        const { controller } = await mountLifecycle({
            clearSession,
            shouldClearSessionAfterTimeout: () => false,
            reconcilePopupSurfaces: vi.fn().mockResolvedValue(undefined),
            handleShortcutAutoPaste: vi.fn().mockResolvedValue(undefined),
        });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)?.({ sequence: 1 });
        await flushLifecycle();

        expect(clearSession).not.toHaveBeenCalled();
        expect(controller.focusSearchInput).toHaveBeenCalled();
    });

    it('user sees the reopened completed conversation fit the window again', async () => {
        const remeasureSearchWindowHeight = vi.fn().mockResolvedValue(undefined);
        await mountLifecycle({
            shouldClearSessionAfterTimeout: () => false,
            reconcilePopupSurfaces: vi.fn().mockResolvedValue(undefined),
            handleShortcutAutoPaste: vi.fn().mockResolvedValue(undefined),
            remeasureSearchWindowHeight,
        });

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_HIDDEN)!({
            sequence: 1,
            reason: 'app-blur-hide',
        });
        await flushLifecycle();
        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)!(
            createStatusChangedPayload('completed')
        );
        await flushLifecycle();

        remeasureSearchWindowHeight.mockClear();

        await eventHandlers.get(AppEvent.SEARCH_SURFACE_SHOWN)!({
            source: 'notification',
            sequence: 2,
        });
        await flushLifecycle();

        expect(remeasureSearchWindowHeight).toHaveBeenCalled();
    });
});
