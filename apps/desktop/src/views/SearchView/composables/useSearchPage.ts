/**
 * SearchView 页面层。
 * 集中管理页面 controller、生命周期编排、overlay 打开时序与 DOM 事件挂载。
 */
import { useAlert } from '@composables/useAlert';
import {
    mapSearchSurfaceSource,
    trackSurfaceOpened,
} from '@services/AnalyticsService/productInteractions';
import {
    AppEvent,
    type AppEventMap,
    type AppEventName,
    eventService,
} from '@services/EventService';
import type {
    SearchSurfaceCommandEvent,
    SearchSurfaceHiddenEvent,
    SearchSurfaceShownEvent,
    SearchSurfaceShowSource,
    SessionStatusReminderActionEvent,
} from '@services/EventService/types';
import { native } from '@services/NativeService';
import { initNotificationPermission, notify } from '@services/NotificationService';
import { log } from '@services/ObservabilityService';
import { runStartupTasks } from '@services/StartupService';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { nextTick, onMounted, onUnmounted, type Ref, ref, watch } from 'vue';

import {
    SEARCH_KEYBINDING_DEFINITIONS,
    type SearchKeybindingActionId,
    type SearchKeybindings,
} from '@/config/searchKeybindings';
import { type MessageKey, type MessageParams, t } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { hasInputHistorySnapshotContent } from '@/types/session';
import { isE2eTestMode } from '@/utils/runtimeMode';
import { normalizeLocalShortcutString } from '@/utils/shortcuts';

import type { ModelDropdownItem } from '../types';
import type {
    ConversationPanelHandle,
    QuickSearchHandle,
    SearchBarHandle,
    SearchPageController,
} from '../types';
import type { createSearchInteractionContext, UseSearchKeyboardOptions } from './searchInteraction';
import { createSearchKeydownHandler } from './searchInteraction';
import { createSessionStatusReminderCoordinator } from './sessionStatusReminder';

const HIDE_TIMEOUT_MS = 5 * 60 * 1000;
const WEBVIEW_BLUR_RECONCILE_DELAY_MS = 50;

interface SearchSurfaceShortcutSyncContext {
    quickSearchOpen: boolean;
}

function shouldSyncSearchSurfaceShortcutToNative(
    actionId: SearchKeybindingActionId,
    context: SearchSurfaceShortcutSyncContext
) {
    if (actionId === 'search.quickSearch.toggleView') {
        return context.quickSearchOpen;
    }

    return true;
}

function buildSearchSurfaceShortcutEntries(
    searchKeybindings: SearchKeybindings,
    context: SearchSurfaceShortcutSyncContext
) {
    return SEARCH_KEYBINDING_DEFINITIONS.flatMap((definition) => {
        if (!shouldSyncSearchSurfaceShortcutToNative(definition.id, context)) {
            return [];
        }

        const shortcut = normalizeLocalShortcutString(searchKeybindings[definition.id]);
        return shortcut ? [{ actionId: definition.id, shortcut }] : [];
    });
}

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

export function filterModelDropdownItems(models: ModelDropdownItem[], searchQuery: string) {
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
        .filter(Boolean) as Array<{ model: ModelDropdownItem; score: number }>;

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

    async function prepareModelDropdownOpen(isCurrent?: () => boolean) {
        if (!searchBar.value) {
            await nextTick();
        }

        await searchBar.value?.prepareModelDropdownOpen(isCurrent);
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

    function isSkillAutocompleteOpen() {
        return searchBar.value?.isSkillAutocompleteOpen() === true;
    }

    function closeSkillAutocomplete() {
        searchBar.value?.closeSkillAutocomplete();
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

    function settleQuickSearchInteraction() {
        quickSearchPanel.value?.settleInteraction();
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
        isSkillAutocompleteOpen,
        isSkillAutocompleteActive: () => searchBar.value?.isSkillAutocompleteActive() === true,
        isFileAutocompleteOpen: () => searchBar.value?.isFileAutocompleteOpen?.() === true,
        closeSkillAutocomplete,
        hasInputContent: () => {
            const snapshot = searchBar.value?.captureInputHistorySnapshot();
            return snapshot ? hasInputHistorySnapshotContent(snapshot) : false;
        },
        openQuickSearch,
        closeQuickSearch,
        settleQuickSearchInteraction,
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
    searchKeybindings?: Readonly<Ref<SearchKeybindings>>;
    /** Native host resize can transiently blur WebView2 during a CSS handoff. */
    isSurfaceTransitioning?: Readonly<Ref<boolean>>;
    interactionContext: ReturnType<typeof createSearchInteractionContext>;
    syncWindowPinState: () => Promise<boolean>;
    clearSession: () => void | Promise<void>;
    shouldClearSessionAfterTimeout?: () => boolean | Promise<boolean>;
    reconcileSearchOverlays?: (restoreFocus?: boolean) => Promise<void>;
    remeasureSearchWindowHeight?: () => void | Promise<void>;
    /** Runs synchronously after the native lifecycle sequence is accepted. */
    onSurfaceVisibilityChange?: (visible: boolean) => void;
    onSurfaceHidden?: () => void | Promise<void>;
    handleSearchSurfaceCommand?: (payload: SearchSurfaceCommandEvent) => void | Promise<void>;
    handleSessionStatusReminderAction?: (
        payload: SessionStatusReminderActionEvent
    ) => void | Promise<void>;
    handleAiModelsUpdated?: () => void | Promise<void>;
    handleShortcutAutoPaste?: (isCurrent?: () => boolean) => void | Promise<void>;
}

export function useSearchPageLifecycle(options: UseSearchPageLifecycleOptions) {
    const {
        controller,
        viewReady,
        isDragging,
        isPinned,
        isMaximized,
        searchKeybindings,
        isSurfaceTransitioning,
        interactionContext,
        syncWindowPinState,
        clearSession,
        shouldClearSessionAfterTimeout,
        reconcileSearchOverlays,
        remeasureSearchWindowHeight,
        onSurfaceVisibilityChange,
        onSurfaceHidden,
        handleSearchSurfaceCommand,
        handleSessionStatusReminderAction,
        handleAiModelsUpdated,
        handleShortcutAutoPaste,
    } = options;

    const settingsStore = useSettingsStore();
    const currentWindow = getCurrentWindow();

    const unlisteners: Array<() => void> = [];
    let disposed = false;
    let stopReadyWatch: (() => void) | null = null;
    let stopPinnedWatch: (() => void) | null = null;
    let stopSearchSurfaceShortcutWatch: (() => void) | null = null;
    let searchSurfaceShortcutSync: Promise<void> = Promise.resolve();
    let lifecycleInitialized = false;
    let restoredActivationEpoch: number | null = null;
    let latestSurfaceSequence = 0;
    let surfaceLifecycleEpoch = 0;
    let blurReconcileTimer: ReturnType<typeof setTimeout> | null = null;
    let blurReconcileEpoch = 0;
    let previousDragging = isDragging.value;
    const sessionStatusReminderCoordinator = createSessionStatusReminderCoordinator({
        isSearchSurfaceForegrounded: () =>
            interactionContext.state.windowVisible &&
            interactionContext.state.windowFocused &&
            interactionContext.state.appFocused,
        onReminderAction: handleSessionStatusReminderAction,
    });

    function handleReminderSurfaceVisible() {
        sessionStatusReminderCoordinator.handleSurfaceVisible();
    }

    async function hideSearchWindow() {
        await native.window.hideSearchWindow();
    }

    async function syncSearchSurfaceHideOnAppBlur(shouldHide: boolean) {
        const isE2e = await isE2eTestMode();
        await native.window.setSearchSurfaceHideOnAppBlur(shouldHide && !isE2e);
    }

    function syncFocusStateOnFocus() {
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

    async function reconcileSearchOverlaysAfterActivation() {
        await reconcileSearchOverlays?.();
    }

    async function restoreSearchWindowAfterActivation(
        surfaceSource: SearchSurfaceShowSource,
        isCurrent: () => boolean
    ) {
        await nextTick();
        if (!isCurrent()) return;
        await reconcileSearchOverlaysAfterActivation();
        if (!isCurrent()) return;
        await controller.focusSearchInput();
        if (!isCurrent()) return;
        await controller.loadActiveModel();
        if (!isCurrent()) return;
        await syncWindowPinStateSafely('focus');
        if (!isCurrent()) return;
        await remeasureSearchWindowHeightSafely('activation');
        if (!isCurrent()) return;

        if (surfaceSource !== 'shortcut') {
            return;
        }

        try {
            await handleShortcutAutoPaste?.(isCurrent);
        } catch (error) {
            log.error('[SearchView] Failed to handle shortcut auto-paste:', error);
        }
    }

    async function handleSearchWindowActivated(
        surfaceSource: SearchSurfaceShowSource,
        isCurrent: () => boolean
    ) {
        if (!isCurrent()) return;
        interactionContext.recordActivation(surfaceSource === 'shortcut' ? 'shortcut' : 'manual');
        syncFocusStateOnFocus();

        const timedOut = interactionContext.shouldRunTimeoutClearOnFocus(
            interactionContext.state.visibilityEpoch,
            Date.now(),
            HIDE_TIMEOUT_MS
        );
        if (timedOut) {
            const shouldClear = await Promise.resolve(shouldClearSessionAfterTimeout?.() ?? true);
            if (!isCurrent()) return;
            if (shouldClear) {
                await Promise.resolve(clearSession());
                if (!isCurrent()) return;
            }
        }

        if (!isCurrent()) return;
        const activationEpoch = interactionContext.state.activationEpoch;
        if (restoredActivationEpoch === activationEpoch) {
            await reconcileSearchOverlaysAfterActivation();
            if (!isCurrent()) return;
            return;
        }
        restoredActivationEpoch = activationEpoch;

        await restoreSearchWindowAfterActivation(surfaceSource, isCurrent);
    }

    async function initializeGlobalShortcut() {
        if (await isE2eTestMode()) {
            return;
        }

        try {
            await settingsStore.initialize();
            await native.shortcut.registerGlobalShortcut(settingsStore.globalShortcut);
        } catch (error) {
            log.error('[SearchView] Failed to initialize global shortcut:', error);

            const errorStr = String(error);
            let messageKey: MessageKey = 'notification.shortcutRegistrationFailed.generic';
            let messageParams: MessageParams = { error: errorStr };

            if (errorStr.includes('already registered') || errorStr.includes('已注册')) {
                messageKey = 'notification.shortcutRegistrationFailed.alreadyRegisteredInSettings';
                messageParams = {};
            } else if (errorStr.includes('invalid') || errorStr.includes('无效')) {
                messageKey = 'notification.shortcutRegistrationFailed.invalidInSettings';
                messageParams = {};
            } else if (errorStr.includes('Unknown key')) {
                messageKey = 'notification.shortcutRegistrationFailed.unsupportedInSettings';
                messageParams = {};
            }

            notify({
                title: t('notification.shortcutRegistrationFailed.title'),
                body: t(messageKey, messageParams),
            });
        }
    }

    async function syncSearchSurfaceShortcutsSafely() {
        if (!searchKeybindings) {
            return;
        }

        const entries = buildSearchSurfaceShortcutEntries(searchKeybindings.value, {
            quickSearchOpen: controller.isQuickSearchOpen(),
        });
        searchSurfaceShortcutSync = searchSurfaceShortcutSync
            .catch(() => undefined)
            .then(() => native.shortcut.setSearchSurfaceShortcuts(entries))
            .catch((error) => {
                log.error('[SearchView] Failed to sync search surface shortcuts:', error);
            });

        await searchSurfaceShortcutSync;
    }

    async function initializeSearchView() {
        try {
            await initializeGlobalShortcut();
            useAlert();
        } catch (error) {
            log.error('[SearchView] Failed to initialize:', error);
        }
    }

    async function syncWindowPinStateSafely(reason: 'initialize' | 'focus') {
        try {
            await syncWindowPinState();
        } catch (error) {
            log.error(`[SearchView] Failed to sync window pin state on ${reason}:`, error);
        }
    }

    async function remeasureSearchWindowHeightSafely(reason: 'activation') {
        try {
            await Promise.resolve(remeasureSearchWindowHeight?.());
        } catch (error) {
            log.error(`[SearchView] Failed to remeasure search window height on ${reason}:`, error);
        }
    }

    async function startLifecycleOnceReady() {
        if (disposed || lifecycleInitialized || !viewReady.value) {
            return;
        }

        lifecycleInitialized = true;
        await initializeSearchView();
        if (disposed) return;
        const visible = await currentWindow.isVisible().catch(() => true);
        if (disposed) return;
        interactionContext.state.windowVisible = visible;
        interactionContext.setWindowFocused(interactionContext.state.windowVisible);
        interactionContext.setAppFocused(interactionContext.state.windowVisible);
        if (interactionContext.state.windowVisible) {
            handleReminderSurfaceVisible();
        }
        await syncWindowPinStateSafely('initialize');
        if (disposed) return;
        await initFocusListener();
        if (disposed) return;
        startSearchSurfaceShortcutSync();
        const isE2e = await isE2eTestMode();
        if (disposed) return;
        if (!isE2e) {
            await initNotificationPermission();
        }
        if (disposed) return;
        await runStartupTasks();
    }

    function startSearchSurfaceShortcutSync() {
        if (!searchKeybindings || stopSearchSurfaceShortcutWatch) {
            return;
        }

        stopSearchSurfaceShortcutWatch = watch(
            [searchKeybindings, () => controller.isQuickSearchOpen()],
            () => {
                void syncSearchSurfaceShortcutsSafely();
            },
            { deep: true, immediate: true, flush: 'post' }
        );
    }

    async function listenWhileMounted<T extends AppEventName>(
        event: T,
        callback: (payload: AppEventMap[T]) => void
    ) {
        if (disposed) return;
        const unlisten = await eventService.on(event, (payload) => {
            if (!disposed) return callback(payload);
        });
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
    }

    async function initFocusListener() {
        await listenWhileMounted(AppEvent.AI_MODELS_UPDATED, () => {
            if (!handleAiModelsUpdated) {
                controller.invalidateModelDropdownData();
                return;
            }

            void Promise.resolve(handleAiModelsUpdated()).catch((error) => {
                log.error('[SearchView] Failed to sync model dropdown after models update:', error);
            });
        });

        await listenWhileMounted(
            AppEvent.SESSION_TASK_STATUS_CHANGED,
            sessionStatusReminderCoordinator.handleTaskStatusChanged
        );

        await listenWhileMounted(
            AppEvent.SESSION_STATUS_REMINDER_ACTION,
            sessionStatusReminderCoordinator.handleReminderAction
        );

        await listenWhileMounted(AppEvent.SEARCH_SURFACE_COMMAND, async (payload) => {
            await Promise.resolve(handleSearchSurfaceCommand?.(payload)).catch((error) => {
                log.error('[SearchView] Failed to handle search surface command:', error);
            });
        });
    }

    async function handleSearchSurfaceShown(payload: SearchSurfaceShownEvent) {
        if (disposed || payload.sequence < latestSurfaceSequence) return;
        cancelPendingBlurReconcile();
        latestSurfaceSequence = payload.sequence;
        surfaceLifecycleEpoch += 1;
        const lifecycleEpoch = surfaceLifecycleEpoch;
        const isCurrent = () =>
            lifecycleEpoch === surfaceLifecycleEpoch && interactionContext.state.windowVisible;
        interactionContext.markWindowVisible();
        onSurfaceVisibilityChange?.(true);
        void trackSurfaceOpened(mapSearchSurfaceSource(payload.source));
        handleReminderSurfaceVisible();
        await handleSearchWindowActivated(payload.source, isCurrent);
    }

    async function handleSearchSurfaceHidden(payload: SearchSurfaceHiddenEvent) {
        if (disposed || payload.sequence < latestSurfaceSequence) return;
        cancelPendingBlurReconcile();
        latestSurfaceSequence = payload.sequence;
        surfaceLifecycleEpoch += 1;
        controller.settleQuickSearchInteraction();
        interactionContext.markWindowHidden({
            hideReason: payload.reason,
            hiddenAt: Date.now(),
        });
        onSurfaceVisibilityChange?.(false);
        await Promise.resolve(onSurfaceHidden?.()).catch((error) => {
            log.error('[SearchView] Failed to clear UI after surface hidden:', error);
        });
    }

    function cancelPendingBlurReconcile() {
        blurReconcileEpoch += 1;
        if (blurReconcileTimer === null) return;
        clearTimeout(blurReconcileTimer);
        blurReconcileTimer = null;
    }

    const handleWindowFocus = () => {
        cancelPendingBlurReconcile();
        interactionContext.markWindowVisible();
        interactionContext.setWindowFocused(true);
        interactionContext.setAppFocused(true);
        handleReminderSurfaceVisible();
    };
    const handleWindowBlur = () => {
        interactionContext.setWindowFocused(false);
        cancelPendingBlurReconcile();
        const epoch = blurReconcileEpoch;
        const isCurrent = () => !disposed && epoch === blurReconcileEpoch;
        // Native bounded-host resizing can produce a transient WebView blur
        // before focus returns. Wait through the native foreground recheck so
        // that event pair does not dismiss an overlay that is being opened
        // during the resize.
        blurReconcileTimer = setTimeout(() => {
            blurReconcileTimer = null;
            void currentWindow
                .isFocused()
                .then((nativeWindowFocused) => {
                    if (!isCurrent() || document.hasFocus() || nativeWindowFocused) return;

                    // The native Focused(false) event is normally responsible for
                    // hiding the bounded search surface. WebView2 can lose focus
                    // without delivering that native event when the host is being
                    // resized, so keep a renderer-side fallback for the same
                    // confirmed app-blur state. Pinned/maximized surfaces still
                    // dismiss their overlays but remain visible.
                    return Promise.resolve(reconcileSearchOverlays?.(false)).then(() => {
                        if (
                            isCurrent() &&
                            !isPinned.value &&
                            !isDragging.value &&
                            !isMaximized?.value &&
                            !isSurfaceTransitioning?.value
                        ) {
                            return native.window.reconcileSearchWindowBlur();
                        }
                    });
                })
                .catch((error) => {
                    log.error('[SearchView] Failed to dismiss overlays after window blur:', error);
                });
        }, WEBVIEW_BLUR_RECONCILE_DELAY_MS);
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
                const wasDragging = previousDragging;
                previousDragging = dragging;
                interactionContext.state.isPinned = nextPinned;
                const shouldHideOnAppBlur = !nextPinned && !dragging && !maximized;
                const policyOperation = syncSearchSurfaceHideOnAppBlur(shouldHideOnAppBlur);

                const interactionEndedWhileUnfocused =
                    wasDragging &&
                    !dragging &&
                    !nextPinned &&
                    !maximized &&
                    interactionContext.state.windowVisible &&
                    (!interactionContext.state.windowFocused ||
                        !interactionContext.state.appFocused);
                if (interactionEndedWhileUnfocused) {
                    const epoch = blurReconcileEpoch;
                    void policyOperation
                        .catch((error) => {
                            log.error(
                                '[SearchView] Failed to sync search surface app-blur policy:',
                                error
                            );
                        })
                        .then(() => {
                            if (
                                !disposed &&
                                epoch === blurReconcileEpoch &&
                                !isPinned.value &&
                                !isDragging.value &&
                                !isMaximized?.value &&
                                interactionContext.state.windowVisible &&
                                (!interactionContext.state.windowFocused ||
                                    !interactionContext.state.appFocused)
                            ) {
                                return native.window.reconcileSearchWindowBlur();
                            }
                        })
                        .catch((error) => {
                            log.error(
                                '[SearchView] Failed to hide search surface after panel interaction:',
                                error
                            );
                        });
                    return;
                }

                void policyOperation.catch((error) => {
                    log.error('[SearchView] Failed to sync search surface app-blur policy:', error);
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
        disposed = true;
        surfaceLifecycleEpoch += 1;
        cancelPendingBlurReconcile();
        window.removeEventListener('focus', handleWindowFocus);
        window.removeEventListener('blur', handleWindowBlur);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        stopReadyWatch?.();
        stopReadyWatch = null;
        stopPinnedWatch?.();
        stopPinnedWatch = null;
        stopSearchSurfaceShortcutWatch?.();
        stopSearchSurfaceShortcutWatch = null;
        for (const unlisten of unlisteners.splice(0)) unlisten();
    });

    return {
        hideSearchWindow,
        handleSearchSurfaceShown,
        handleSearchSurfaceHidden,
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
        sessionHistoryOverlayOpen,
        hideAllOverlays,
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
            target?.closest('[data-history-trigger="true"]') ||
            target?.closest('[data-search-overlay-host="true"]')
        ) {
            return;
        }

        if (modelDropdownState.value.isOpen) {
            void hideAllOverlays();
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        if (sessionHistoryOverlayOpen.value) {
            void hideAllOverlays();
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

    return {
        routeSearchSurfaceCommand: handleKeyDown.routeSearchSurfaceCommand,
    };
}
