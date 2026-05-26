/**
 * SearchView 页面层。
 * 集中管理页面 controller、生命周期编排、popup 打开时序与 DOM 事件挂载。
 */
import { useAlert } from '@composables/useAlert';
import { AppEvent, eventService } from '@services/EventService';
import type { SessionStatusReminderActionEvent } from '@services/EventService/types';
import { native } from '@services/NativeService';
import { initNotificationPermission, notify } from '@services/NotificationService';
import type { ModelDropdownData, ModelDropdownPopupItem } from '@services/PopupService';
import { popupManager } from '@services/PopupService';
import { runStartupTasks } from '@services/StartupService';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { nextTick, onMounted, onUnmounted, type Ref, ref, watch } from 'vue';

import { useSettingsStore } from '@/stores/settings';
import { isE2eTestMode } from '@/utils/runtimeMode';

import type {
    ConversationPanelHandle,
    QuickSearchHandle,
    SearchBarHandle,
    SearchModelDropdownContext,
    SearchModelDropdownState,
    SearchModelOverride,
    SearchPageController,
} from '../types';
import type { SearchOverlayCommand, SearchPopupSessionIdentity } from './searchInteraction';
import type { createSearchInteractionContext, UseSearchKeyboardOptions } from './searchInteraction';
import { createSearchKeydownHandler } from './searchInteraction';
import { createSessionStatusReminderCoordinator } from './sessionStatusReminder';
import { useModelDropdownPopup } from './useModelDropdownPopup';

const HIDE_TIMEOUT_MS = 5 * 60 * 1000;

export function useSearchWindowPin() {
    const currentWindow = getCurrentWindow();
    const isPinned = ref(false);
    let lastOperation: Promise<void> = Promise.resolve();

    function queuePinOperation<T>(operation: () => Promise<T>): Promise<T> {
        const run = lastOperation.catch(() => undefined).then(operation);
        lastOperation = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    function syncWindowPinState(): Promise<boolean> {
        return queuePinOperation(async () => {
            const nextState = await currentWindow.isAlwaysOnTop();
            isPinned.value = nextState;
            return nextState;
        });
    }

    function setWindowPinned(value: boolean): Promise<boolean> {
        return queuePinOperation(async () => {
            await currentWindow.setAlwaysOnTop(value);
            const nextState = await currentWindow.isAlwaysOnTop();
            isPinned.value = nextState;
            return nextState;
        });
    }

    function toggleWindowPin(): Promise<boolean> {
        return queuePinOperation(async () => {
            const currentState = await currentWindow.isAlwaysOnTop();
            await currentWindow.setAlwaysOnTop(!currentState);
            const nextState = await currentWindow.isAlwaysOnTop();
            isPinned.value = nextState;
            return nextState;
        });
    }

    return {
        isPinned,
        syncWindowPinState,
        setWindowPinned,
        toggleWindowPin,
    };
}

function mapPopupModel(
    model: SearchModelDropdownContext['models'][number]
): ModelDropdownPopupItem {
    return {
        id: model.id,
        modelId: model.model_id,
        name: model.name,
        providerId: model.provider_id,
        providerName: model.provider_name,
        reasoning: model.reasoning,
        tool_call: model.tool_call,
        modalities: model.modalities,
        attachment: model.attachment,
        open_weights: model.open_weights,
    };
}

function filterModelDropdownItems(models: ModelDropdownPopupItem[], searchQuery: string) {
    const query = searchQuery.toLowerCase().trim();
    if (!query) {
        return models;
    }

    const tokens = query.split(/\s+/).filter(Boolean);
    const scored = models
        .map((model) => {
            const fields = [
                model.name.toLowerCase(),
                model.modelId.toLowerCase(),
                model.providerName.toLowerCase(),
                `${model.providerName} ${model.modelId}`.toLowerCase(),
            ];

            let totalScore = 0;
            for (const token of tokens) {
                let bestScore = -1;
                for (const field of fields) {
                    const score = scoreModelDropdownMatch(token, field);
                    if (score > bestScore) {
                        bestScore = score;
                    }
                }

                if (bestScore < 0) {
                    return null;
                }

                totalScore += bestScore;
            }

            return {
                model,
                score: totalScore,
            };
        })
        .filter(Boolean) as Array<{ model: ModelDropdownPopupItem; score: number }>;

    return scored.sort((left, right) => right.score - left.score).map((item) => item.model);
}

function scoreModelDropdownMatch(token: string, text: string) {
    if (!token) {
        return -1;
    }

    const index = text.indexOf(token);
    if (index !== -1) {
        return 200 - index;
    }

    if (isModelDropdownSubsequence(token, text)) {
        return 100;
    }

    return -1;
}

function isModelDropdownSubsequence(needle: string, haystack: string) {
    let currentIndex = 0;
    for (const char of haystack) {
        if (char === needle[currentIndex]) {
            currentIndex += 1;
            if (currentIndex >= needle.length) {
                return true;
            }
        }
    }

    return false;
}

/**
 * 搜索页子组件命令适配层。
 */
export function useSearchPageController(options: {
    searchBar: Ref<SearchBarHandle | undefined>;
    quickSearchOpen: Ref<boolean>;
    quickSearchPanel: Ref<QuickSearchHandle | undefined>;
    conversationPanel: Ref<ConversationPanelHandle | undefined>;
}): SearchPageController {
    const { searchBar, quickSearchOpen, quickSearchPanel, conversationPanel } = options;

    function focusConversation() {
        conversationPanel.value?.focus();
    }

    async function focusSearchInput() {
        await searchBar.value?.focus();
    }

    async function loadActiveModel() {
        await searchBar.value?.loadActiveModel();
    }

    async function prefetchModelDropdownData() {
        await searchBar.value?.prefetchModelDropdownData();
    }

    function invalidateModelDropdownData() {
        searchBar.value?.invalidateModelDropdownData();
    }

    async function prepareModelDropdownOpen() {
        if (!searchBar.value) {
            await nextTick();
        }

        await searchBar.value?.prepareModelDropdownOpen();
    }

    async function selectModelFromDropdown(modelDbId: number) {
        return (
            (await searchBar.value?.selectModelFromDropdown(modelDbId)) ?? {
                modelId: null,
                providerId: null,
            }
        );
    }

    function getModelDropdownAnchor() {
        return searchBar.value?.getModelDropdownAnchor() ?? null;
    }

    function getModelDropdownContext() {
        return (
            searchBar.value?.getModelDropdownContext() ?? {
                activeModelId: null,
                activeProviderId: null,
                selectedModelId: null,
                selectedProviderId: null,
                models: [],
            }
        );
    }

    function isQuickSearchOpen() {
        return quickSearchOpen.value;
    }

    function isQuickSearchItemHighlighted() {
        return quickSearchPanel.value?.getHighlightedItem() !== null;
    }

    function openQuickSearch() {
        quickSearchPanel.value?.open();
    }

    function closeQuickSearch() {
        if (quickSearchPanel.value) {
            quickSearchPanel.value.close();
            return;
        }

        quickSearchOpen.value = false;
    }

    function moveQuickSearchSelection(direction: 'up' | 'down' | 'left' | 'right') {
        quickSearchPanel.value?.moveSelection(direction);
    }

    async function openHighlightedQuickSearchItem() {
        await quickSearchPanel.value?.openHighlightedItem();
    }

    function triggerQuickSearch(query: string) {
        quickSearchPanel.value?.triggerSearch(query);
    }

    function goToPageQuickSearch(page: number) {
        quickSearchPanel.value?.goToPage(page);
    }

    function goToNextPageQuickSearch() {
        quickSearchPanel.value?.goToNextPage();
    }

    function goToPreviousPageQuickSearch() {
        quickSearchPanel.value?.goToPreviousPage();
    }

    function openQuickSearchContextMenu() {
        quickSearchPanel.value?.openContextMenuForHighlightedItem();
    }

    function toggleQuickSearchView() {
        quickSearchPanel.value?.toggleViewMode();
    }

    function collapseQuickSearch() {
        quickSearchPanel.value?.collapseToDefault();
        void focusSearchInput();
    }

    function isQuickSearchContextMenuOpen() {
        return quickSearchPanel.value?.isContextMenuOpen ?? false;
    }

    function closeQuickSearchContextMenu() {
        quickSearchPanel.value?.closeContextMenu();
        void focusSearchInput();
    }

    return {
        focusConversation,
        focusSearchInput,
        loadActiveModel,
        prefetchModelDropdownData,
        invalidateModelDropdownData,
        prepareModelDropdownOpen,
        selectModelFromDropdown,
        getModelDropdownAnchor,
        getModelDropdownContext,
        isQuickSearchOpen,
        isQuickSearchItemHighlighted,
        openQuickSearch,
        closeQuickSearch,
        moveQuickSearchSelection,
        openHighlightedQuickSearchItem,
        triggerQuickSearch,
        goToPageQuickSearch,
        goToNextPageQuickSearch,
        goToPreviousPageQuickSearch,
        openQuickSearchContextMenu,
        toggleQuickSearchView,
        collapseQuickSearch,
        isQuickSearchContextMenuOpen,
        closeQuickSearchContextMenu,
    };
}

interface UseSearchPanelFocusRestoreOptions {
    controller: SearchPageController;
}

export function useSearchPanelFocusRestore(options: UseSearchPanelFocusRestoreOptions) {
    const { controller } = options;

    function hasActiveTextSelection() {
        const selection = window.getSelection();
        return Boolean(
            selection && !selection.isCollapsed && selection.toString().trim().length > 0
        );
    }

    function restoreSearchFocusAfterSelectionClears() {
        requestAnimationFrame(() => {
            if (hasActiveTextSelection()) {
                return;
            }

            void controller.focusSearchInput();
        });
    }

    function handleQuickSearchBlankClick() {
        if (hasActiveTextSelection()) {
            restoreSearchFocusAfterSelectionClears();
            return;
        }

        void controller.focusSearchInput();
    }

    return {
        handleQuickSearchBlankClick,
    };
}

interface UseSearchPageLifecycleOptions {
    controller: SearchPageController;
    viewReady: Ref<boolean>;
    isDragging: Ref<boolean>;
    isPinned: Ref<boolean>;
    isMaximized?: Readonly<Ref<boolean>>;
    interactionContext: ReturnType<typeof createSearchInteractionContext>;
    syncWindowPinState: () => Promise<boolean>;
    clearSession: () => void | Promise<void>;
    reconcilePopupSurfaces?: () => Promise<void>;
    onSurfaceHidden?: () => void | Promise<void>;
    handleSearchSurfaceCommand?: (payload: {
        command: 'toggle-model-dropdown';
        source: 'webview2-accelerator';
    }) => void | Promise<void>;
    handleSessionStatusReminderAction?: (
        payload: SessionStatusReminderActionEvent
    ) => void | Promise<void>;
    handleAiModelsUpdated?: () => void | Promise<void>;
    handleShortcutAutoPaste?: () => void | Promise<void>;
}

export function useSearchPageLifecycle(options: UseSearchPageLifecycleOptions) {
    const {
        controller,
        viewReady,
        isDragging,
        isPinned,
        isMaximized,
        interactionContext,
        syncWindowPinState,
        clearSession,
        reconcilePopupSurfaces,
        onSurfaceHidden,
        handleSearchSurfaceCommand,
        handleSessionStatusReminderAction,
        handleAiModelsUpdated,
        handleShortcutAutoPaste,
    } = options;

    const settingsStore = useSettingsStore();

    let unlistenAiModelsUpdated: (() => void) | null = null;
    let unlistenSearchSurfaceShown: (() => void) | null = null;
    let unlistenSearchSurfaceHidden: (() => void) | null = null;
    let unlistenSearchSurfaceCommand: (() => void) | null = null;
    let unlistenSessionTaskStatusChanged: (() => void) | null = null;
    let unlistenSessionStatusReminderAction: (() => void) | null = null;
    let stopReadyWatch: (() => void) | null = null;
    let stopPinnedWatch: (() => void) | null = null;
    let lifecycleInitialized = false;
    let restoredActivationEpoch: number | null = null;
    let latestSurfaceSequence = 0;
    const sessionStatusReminderCoordinator = createSessionStatusReminderCoordinator({
        isSearchSurfaceVisible: () => interactionContext.state.windowVisible,
        onReminderAction: handleSessionStatusReminderAction,
    });

    function handleReminderSurfaceVisible() {
        sessionStatusReminderCoordinator.handleSurfaceVisible();
    }

    async function hideSearchWindow() {
        await native.window.hideSearchWindow();
    }

    function syncFocusStateOnFocus() {
        interactionContext.clearActivePopupSession();

        if (!interactionContext.state.windowVisible) {
            if (interactionContext.state.activationSource === 'unknown') {
                interactionContext.recordActivation('manual');
            } else {
                interactionContext.markWindowVisible();
            }
        } else {
            interactionContext.markWindowVisible();
        }

        interactionContext.setWindowFocused(true);
        interactionContext.setAppFocused(true);
    }

    function hasActivePopupWindowFocus() {
        const popupManagerState = popupManager.state ?? {
            isOpen: false,
            currentType: null,
            currentPopupId: null,
            currentWindowLabel: null,
            currentPopupSessionVersion: null,
        };
        const activePopupIdentity = interactionContext.state.activePopupIdentity;

        return (
            popupManagerState.isOpen === true &&
            activePopupIdentity !== null &&
            popupManagerState.currentPopupId === activePopupIdentity.popupId &&
            popupManagerState.currentWindowLabel === activePopupIdentity.windowLabel &&
            popupManagerState.currentPopupSessionVersion === activePopupIdentity.popupSessionVersion
        );
    }

    async function reconcilePopupSurfacesAfterActivation() {
        if (hasActivePopupWindowFocus()) {
            return;
        }

        await reconcilePopupSurfaces?.();
    }

    async function restoreSearchWindowAfterActivation(surfaceSource: 'shortcut' | 'notification') {
        await nextTick();
        await reconcilePopupSurfacesAfterActivation();
        await controller.focusSearchInput();
        await controller.loadActiveModel();
        await syncWindowPinStateSafely('focus');

        if (surfaceSource !== 'shortcut') {
            return;
        }

        try {
            await handleShortcutAutoPaste?.();
        } catch (error) {
            console.error('[SearchView] Failed to handle shortcut auto-paste:', error);
        }
    }

    async function handleSearchWindowActivated(surfaceSource: 'shortcut' | 'notification') {
        interactionContext.recordActivation(surfaceSource === 'shortcut' ? 'shortcut' : 'manual');
        if (hasActivePopupWindowFocus()) {
            restoredActivationEpoch = interactionContext.state.activationEpoch;
            return;
        }

        syncFocusStateOnFocus();

        if (
            interactionContext.shouldRunTimeoutClearOnFocus(
                interactionContext.state.visibilityEpoch,
                Date.now(),
                HIDE_TIMEOUT_MS
            )
        ) {
            await Promise.resolve(clearSession());
        }

        const activationEpoch = interactionContext.state.activationEpoch;
        if (restoredActivationEpoch === activationEpoch) {
            await reconcilePopupSurfacesAfterActivation();
            return;
        }
        restoredActivationEpoch = activationEpoch;

        await restoreSearchWindowAfterActivation(surfaceSource);
    }

    async function initializeGlobalShortcut() {
        if (await isE2eTestMode()) {
            return;
        }

        try {
            await settingsStore.initialize();
            await native.shortcut.registerGlobalShortcut(settingsStore.globalShortcut);
        } catch (error) {
            console.error('[SearchView] Failed to initialize global shortcut:', error);

            const errorStr = String(error);
            let message = '注册快捷键失败';

            if (errorStr.includes('already registered') || errorStr.includes('已注册')) {
                message = '快捷键已被其他应用占用，请在设置中更换';
            } else if (errorStr.includes('invalid') || errorStr.includes('无效')) {
                message = '快捷键格式无效，请在设置中重新配置';
            } else if (errorStr.includes('Unknown key')) {
                message = '不支持的按键，请在设置中更换';
            }

            notify({
                title: 'TouchAI - 快捷键注册失败',
                body: message,
            });
        }
    }

    async function initializeSearchView() {
        try {
            await initializeGlobalShortcut();
            useAlert();
            await popupManager.initialize();
        } catch (error) {
            console.error('[SearchView] Failed to initialize:', error);
        }
    }

    async function syncWindowPinStateSafely(reason: 'initialize' | 'focus') {
        try {
            await syncWindowPinState();
        } catch (error) {
            console.error(`[SearchView] Failed to sync window pin state on ${reason}:`, error);
        }
    }

    async function startLifecycleOnceReady() {
        if (lifecycleInitialized || !viewReady.value) {
            return;
        }

        lifecycleInitialized = true;
        await initializeSearchView();
        interactionContext.state.windowVisible = await getCurrentWindow()
            .isVisible()
            .catch(() => true);
        interactionContext.setWindowFocused(interactionContext.state.windowVisible);
        interactionContext.setAppFocused(interactionContext.state.windowVisible);
        if (interactionContext.state.windowVisible) {
            handleReminderSurfaceVisible();
        }
        await syncWindowPinStateSafely('initialize');
        await initFocusListener();
        if (!(await isE2eTestMode())) {
            await initNotificationPermission();
        }
        await runStartupTasks();
    }

    async function initFocusListener() {
        unlistenAiModelsUpdated = await eventService.on(AppEvent.AI_MODELS_UPDATED, () => {
            if (!handleAiModelsUpdated) {
                controller.invalidateModelDropdownData();
                return;
            }

            void Promise.resolve(handleAiModelsUpdated()).catch((error) => {
                console.error(
                    '[SearchView] Failed to sync model dropdown after models update:',
                    error
                );
            });
        });

        unlistenSearchSurfaceShown = await eventService.on(
            AppEvent.SEARCH_SURFACE_SHOWN,
            async (payload) => {
                latestSurfaceSequence = Math.max(latestSurfaceSequence, payload.sequence ?? 0);
                interactionContext.markWindowVisible();
                handleReminderSurfaceVisible();
                await handleSearchWindowActivated(payload.source ?? 'shortcut');
            }
        );

        unlistenSearchSurfaceHidden = await eventService.on(
            AppEvent.SEARCH_SURFACE_HIDDEN,
            async (payload) => {
                const sequence = payload.sequence ?? 0;
                if (sequence > 0 && sequence < latestSurfaceSequence) {
                    return;
                }
                latestSurfaceSequence = Math.max(latestSurfaceSequence, sequence);
                interactionContext.clearActivePopupSession();
                interactionContext.markWindowHidden({
                    hideReason: payload.reason,
                    hiddenAt: Date.now(),
                });
                await Promise.resolve(onSurfaceHidden?.()).catch((error) => {
                    console.error('[SearchView] Failed to clear UI after surface hidden:', error);
                });
            }
        );

        unlistenSessionTaskStatusChanged = await eventService.on(
            AppEvent.SESSION_TASK_STATUS_CHANGED,
            sessionStatusReminderCoordinator.handleTaskStatusChanged
        );

        unlistenSessionStatusReminderAction = await eventService.on(
            AppEvent.SESSION_STATUS_REMINDER_ACTION,
            sessionStatusReminderCoordinator.handleReminderAction
        );

        unlistenSearchSurfaceCommand = await eventService.on(
            AppEvent.SEARCH_SURFACE_COMMAND,
            async (payload) => {
                await Promise.resolve(handleSearchSurfaceCommand?.(payload)).catch((error) => {
                    console.error('[SearchView] Failed to handle search surface command:', error);
                });
            }
        );
    }

    const handleWindowFocus = () => {
        interactionContext.markWindowVisible();
        interactionContext.setWindowFocused(true);
        interactionContext.setAppFocused(true);
        handleReminderSurfaceVisible();
    };
    const handleWindowBlur = () => {
        interactionContext.setWindowFocused(false);
    };
    const handleVisibilityChange = () => {
        const isVisible = document.visibilityState !== 'hidden';
        if (isVisible) {
            interactionContext.markWindowVisible();
        }
        interactionContext.setAppFocused(isVisible);
        if (!isVisible) {
            interactionContext.setWindowFocused(false);
            return;
        }

        handleReminderSurfaceVisible();
    };

    onMounted(() => {
        window.addEventListener('focus', handleWindowFocus);
        window.addEventListener('blur', handleWindowBlur);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        stopPinnedWatch = watch(
            [isPinned, isDragging, () => Boolean(isMaximized?.value)],
            ([nextPinned, dragging, maximized]) => {
                interactionContext.state.isPinned = nextPinned;
                void native.window
                    .setSearchSurfaceHideOnAppBlur(!nextPinned && !dragging && !maximized)
                    .catch((error) => {
                        console.error(
                            '[SearchView] Failed to sync search surface app-blur policy:',
                            error
                        );
                    });
            },
            { immediate: true, flush: 'sync' }
        );

        if (viewReady.value) {
            void startLifecycleOnceReady();
            return;
        }

        stopReadyWatch = watch(
            viewReady,
            (ready) => {
                if (!ready) {
                    return;
                }

                stopReadyWatch?.();
                stopReadyWatch = null;
                void startLifecycleOnceReady();
            },
            { flush: 'post' }
        );
    });

    onUnmounted(() => {
        window.removeEventListener('focus', handleWindowFocus);
        window.removeEventListener('blur', handleWindowBlur);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        stopReadyWatch?.();
        stopReadyWatch = null;
        stopPinnedWatch?.();
        stopPinnedWatch = null;
        unlistenAiModelsUpdated?.();
        unlistenAiModelsUpdated = null;
        unlistenSearchSurfaceShown?.();
        unlistenSearchSurfaceShown = null;
        unlistenSearchSurfaceHidden?.();
        unlistenSearchSurfaceHidden = null;
        unlistenSessionTaskStatusChanged?.();
        unlistenSessionTaskStatusChanged = null;
        unlistenSessionStatusReminderAction?.();
        unlistenSessionStatusReminderAction = null;
        unlistenSearchSurfaceCommand?.();
        unlistenSearchSurfaceCommand = null;
    });

    return {
        hideSearchWindow,
    };
}

interface UseSearchModelDropdownCoordinatorOptions {
    pageContainer: Ref<HTMLElement | null>;
    controller: SearchPageController;
    modelOverride: Ref<SearchModelOverride>;
    modelDropdownState: Ref<SearchModelDropdownState>;
    modelDropdownQuery: Ref<string>;
    requestModelDropdownOpen: () => SearchOverlayCommand;
    handleQuickSearchClosedForModelDropdown: () => SearchOverlayCommand;
    handleLayoutStableForModelDropdown: () => SearchOverlayCommand;
    handleModelDropdownOpened: () => void;
    handleModelDropdownClosed: () => void;
    syncOverlayState: () => void;
    onPopupSessionStart?: (identity: SearchPopupSessionIdentity) => void;
    onPopupSessionEnd?: () => void;
}

export function useSearchModelDropdownCoordinator(
    options: UseSearchModelDropdownCoordinatorOptions
) {
    const {
        pageContainer,
        controller,
        modelOverride,
        modelDropdownState,
        modelDropdownQuery,
        requestModelDropdownOpen,
        handleQuickSearchClosedForModelDropdown,
        handleLayoutStableForModelDropdown,
        handleModelDropdownOpened,
        handleModelDropdownClosed,
        syncOverlayState,
        onPopupSessionStart,
        onPopupSessionEnd,
    } = options;

    function getPopupData(): ModelDropdownData {
        const context = controller.getModelDropdownContext();
        return {
            activeModelId: context.activeModelId ?? '',
            activeProviderId: context.activeProviderId,
            selectedModelId: context.selectedModelId ?? '',
            selectedProviderId: context.selectedProviderId,
            searchQuery: modelDropdownQuery.value,
            models: filterModelDropdownItems(
                context.models.filter((model) => model.provider_enabled === 1).map(mapPopupModel),
                modelDropdownQuery.value
            ),
        };
    }

    const dropdownPopup = useModelDropdownPopup({
        getAnchorElement: controller.getModelDropdownAnchor,
        getPopupData,
        isModelDropdownActive: () => modelDropdownState.value.isOpen,
        onModelSelect: async (modelDbId) => {
            modelOverride.value = await controller.selectModelFromDropdown(modelDbId);
            await closeModelDropdown();
        },
        onModelSearchQueryChange: (query) => {
            modelDropdownQuery.value = query;
        },
        onClose: () => {
            modelDropdownState.value = {
                isOpen: false,
            };
            modelDropdownQuery.value = '';
            handleModelDropdownClosed();
        },
        onPopupSessionStart,
        onPopupSessionEnd,
    });

    async function waitForLayoutStable() {
        const el = pageContainer.value;
        if (!el) {
            return;
        }

        const maxWaitMs = 200;
        const stableFramesRequired = 2;
        const heightThreshold = 0.5;
        const start = performance.now();
        let stableFrames = 0;
        let lastHeight = el.getBoundingClientRect().height;

        while (performance.now() - start < maxWaitMs) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const currentHeight = el.getBoundingClientRect().height;
            if (Math.abs(currentHeight - lastHeight) <= heightThreshold) {
                stableFrames += 1;
                if (stableFrames >= stableFramesRequired) {
                    return;
                }
            } else {
                stableFrames = 0;
                lastHeight = currentHeight;
            }
        }
    }

    async function runModelDropdownOpenSequence(initialCommand: SearchOverlayCommand) {
        let command = initialCommand;

        while (command !== 'noop') {
            if (command === 'close-quick-search') {
                controller.closeQuickSearch();
                await nextTick();
                command = handleQuickSearchClosedForModelDropdown();
                continue;
            }

            if (command === 'wait-layout-stable') {
                await waitForLayoutStable();
                command = handleLayoutStableForModelDropdown();
                continue;
            }

            if (command === 'open-model-dropdown') {
                try {
                    await controller.prepareModelDropdownOpen();
                    modelDropdownQuery.value = '';
                    await dropdownPopup.open();
                    modelDropdownState.value = {
                        isOpen: dropdownPopup.isOpen.value,
                    };
                    if (dropdownPopup.isOpen.value) {
                        handleModelDropdownOpened();
                    } else {
                        handleModelDropdownClosed();
                    }
                } catch (error) {
                    modelDropdownState.value = {
                        isOpen: false,
                    };
                    modelDropdownQuery.value = '';
                    syncOverlayState();
                    console.error('[SearchView] Failed to open model dropdown popup:', error);
                }
                return;
            }
        }
    }

    async function openModelDropdownWithLayoutSync() {
        const command = requestModelDropdownOpen();
        if (command === 'noop') {
            return;
        }

        await runModelDropdownOpenSequence(command);
    }

    async function closeModelDropdown() {
        try {
            await dropdownPopup.close();
        } finally {
            modelDropdownState.value = {
                isOpen: false,
            };
            modelDropdownQuery.value = '';
            handleModelDropdownClosed();
        }
    }

    async function hideAllDropdowns() {
        if (!modelDropdownState.value.isOpen) {
            handleModelDropdownClosed();
            return;
        }

        await closeModelDropdown();
    }

    async function refreshModelDropdownData() {
        if (!modelDropdownState.value.isOpen) {
            return;
        }

        await dropdownPopup.updateData();
    }

    async function handleToggleModelDropdownRequest() {
        if (modelDropdownState.value.isOpen && dropdownPopup.isOpen.value) {
            if (dropdownPopup.isLiveSession()) {
                await closeModelDropdown();
                return;
            }

            modelDropdownState.value = {
                isOpen: false,
            };
            modelDropdownQuery.value = '';
            handleModelDropdownClosed();
        }

        if (modelDropdownState.value.isOpen && !dropdownPopup.isOpen.value) {
            modelDropdownState.value = {
                isOpen: false,
            };
            handleModelDropdownClosed();
        }

        await openModelDropdownWithLayoutSync();
    }

    watch(
        () => [modelDropdownState.value.isOpen, modelDropdownQuery.value],
        ([isOpen]) => {
            if (!isOpen) {
                return;
            }

            void dropdownPopup.updateData();
        },
        { flush: 'post' }
    );

    return {
        openModelDropdownWithLayoutSync,
        closeModelDropdown,
        hideAllDropdowns,
        refreshModelDropdownData,
        handleToggleModelDropdownRequest,
    };
}

/**
 * 搜索页全局 DOM 输入链路。
 * 这里只做监听挂载和点击收敛，键盘语义解释由交互层提供。
 */
export function useSearchKeyboard(options: UseSearchKeyboardOptions) {
    const {
        viewReady,
        modelDropdownState,
        sessionHistoryPopupOpen,
        hideAllPopups,
        hideSearchWindow,
    } = options;

    const handleKeyDown = createSearchKeydownHandler(options);

    function handleSearchWindowMouseDown(event: MouseEvent) {
        if (!viewReady.value) {
            return;
        }

        const target = event.target as HTMLElement | null;
        if (
            target?.closest('.logo-container') ||
            target?.closest('[data-history-trigger="true"]')
        ) {
            return;
        }

        if (modelDropdownState.value.isOpen) {
            void hideAllPopups();
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        if (sessionHistoryPopupOpen.value) {
            void hideAllPopups();
        }
    }

    function handleSearchWindowClick(event: MouseEvent) {
        if (!viewReady.value) {
            return;
        }

        if (event.target === document.body) {
            void hideSearchWindow();
        }
    }

    onMounted(() => {
        window.addEventListener('keydown', handleKeyDown, true);
        document.addEventListener('mousedown', handleSearchWindowMouseDown, true);
        document.body.addEventListener('click', handleSearchWindowClick);
    });

    onUnmounted(() => {
        window.removeEventListener('keydown', handleKeyDown, true);
        document.removeEventListener('mousedown', handleSearchWindowMouseDown, true);
        document.body.removeEventListener('click', handleSearchWindowClick);
    });
}
