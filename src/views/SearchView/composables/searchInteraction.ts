/**
 * SearchView 交互语义层。
 * 收口页面交互状态、QuickSearch / overlay 策略与键盘语义解释，
 * 避免页面编排层和输入层同时承载交互规则。
 */
import { AppEvent, eventService } from '@services/EventService';
import type { PopupKeydownPayload } from '@services/PopupService';
import { computed, type ComputedRef, reactive, type Ref, ref, watch } from 'vue';

import type { PendingToolApproval, SessionMessage } from '@/types/session';

import type {
    PendingRequest,
    SearchCursorContext,
    SearchModelDropdownState,
    SearchModelOverride,
    SearchOverlayState,
    SearchPageController,
} from '../types';

export type SearchActivationSource = 'shortcut' | 'manual' | 'unknown';

export type SearchHideReason = 'app-blur-hide' | 'manual-dismiss' | 'policy-toggle-hide';

export type SearchPopupSurfaceType = 'model-dropdown-surface' | 'session-history-surface';

export type SearchOverlayCommand =
    | 'noop'
    | 'close-quick-search'
    | 'wait-layout-stable'
    | 'open-model-dropdown';

export interface SearchPopupSessionIdentity {
    popupId: string;
    windowLabel: string;
    popupSessionVersion: number;
}

export interface SearchActivationContextState {
    activationEpoch: number;
    activationSource: SearchActivationSource;
    visibilityEpoch: number;
    windowVisible: boolean;
    windowFocused: boolean;
    appFocused: boolean;
    lastHideReason: SearchHideReason | null;
    entryCheckArmedVisibilityEpoch: number | null;
    lastEntryCheckedVisibilityEpoch: number | null;
    timeoutClearArmedVisibilityEpoch: number | null;
    lastHideAt: number | null;
    isPinned: boolean;
}

export interface SearchInteractionContextState extends SearchActivationContextState {
    activePopupType: SearchPopupSurfaceType | null;
    activePopupIdentity: SearchPopupSessionIdentity | null;
}

interface MarkWindowHiddenInput {
    hideReason: SearchHideReason;
    hiddenAt: number;
}

interface ShouldCheckShortcutEntryInput {
    activationSource: SearchActivationSource;
    visibilityEpoch: number;
    entryCheckArmedVisibilityEpoch: number | null;
    lastEntryCheckedVisibilityEpoch: number | null;
}

type PopupSessionEventIdentity = SearchPopupSessionIdentity;

interface UseQuickSearchCoordinatorOptions {
    queryText: Ref<string>;
    attachments: Ref<unknown[]>;
    sessionHistory: Ref<SessionMessage[]>;
    cursorContext: Ref<SearchCursorContext>;
    modelOverride: Ref<SearchModelOverride>;
    modelDropdownState: Ref<SearchModelDropdownState>;
    quickSearchOpen: Ref<boolean>;
    controller: SearchPageController;
    suppressNextAutoOpen?: Ref<boolean>;
}

interface UseSearchOverlayMachineOptions {
    isQuickSearchOpen: ComputedRef<boolean>;
    modelDropdownState: Ref<SearchModelDropdownState>;
}

interface SyncOverlayStateOptions {
    force?: boolean;
}

type SearchKeyboardSurface = 'search-surface' | SearchPopupSurfaceType;
type SearchQuickSearchDirection = 'up' | 'down' | 'left' | 'right';
type SearchPrimaryShortcutKey = 'h' | 'l' | 'n' | 'm' | 'p' | '.' | 'backspace';

interface PendingApprovalState {
    callId?: string;
    keyboardApproveAt: number;
}

interface SearchKeyboardRouteInput {
    key: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
}

interface CreateSearchKeyboardRouterOptions {
    getPendingApproval: () => PendingApprovalState | null;
    getActiveSurface: () => SearchKeyboardSurface;
    hasActivePopupWindowFocus: () => boolean;
    getQueryText: () => string;
    isQuickSearchOpen: () => boolean;
    hasQuickSearchHighlight: () => boolean;
    shouldTriggerQuickSearch: (query: string) => boolean;
    isMultiLineCursor: () => boolean;
    hasModelOverride: () => boolean;
    getSessionHistoryCount: () => number;
    isLoading: () => boolean;
    onPromptApprovalAttention: () => void;
    onRejectApproval: (callId?: string) => void;
    onApproveApproval: (callId?: string) => void;
    onForwardToPopup: (key: string) => void;
    onSubmit: () => void | Promise<void>;
    onOpenQuickSearch: () => void;
    onMoveQuickSearchSelection: (direction: SearchQuickSearchDirection) => void;
    onOpenHighlightedQuickSearchItem: () => void | Promise<void>;
    onCloseQuickSearch: () => void;
    onHideAllPopups: () => void | Promise<void>;
    onCancelRequest: () => void;
    onClearModelOverride: () => void;
    onHideWindow: () => void | Promise<void>;
    onClearSession: () => void;
    onClearDraft: () => void;
    onClearAll: () => void;
    onPrimaryShortcut: (key: SearchPrimaryShortcutKey) => void | Promise<void>;
}

export interface UseSearchKeyboardOptions {
    viewReady: Ref<boolean>;
    queryText: Ref<string>;
    cursorContext: Ref<SearchCursorContext>;
    modelOverride: Ref<SearchModelOverride>;
    modelDropdownState: Ref<SearchModelDropdownState>;
    controller: SearchPageController;
    sessionHistory: Ref<SessionMessage[]>;
    pendingRequest: Ref<PendingRequest | null>;
    isWaitingForCompletion: Ref<boolean>;
    isLoading: Ref<boolean>;
    pendingToolApproval: Ref<PendingToolApproval | null>;
    approvePendingToolApproval: (callId?: string) => boolean;
    rejectPendingToolApproval: (callId?: string) => boolean;
    promptPendingToolApprovalAttention: () => void;
    getActivePopupType: () => SearchPopupSurfaceType | null;
    hasActivePopupWindowFocus: () => boolean;
    isQuickSearchOpen: ComputedRef<boolean>;
    shouldTriggerQuickSearch: (query: string) => boolean;
    sessionHistoryPopupOpen: Ref<boolean>;
    hideAllPopups: () => Promise<void>;
    hideSearchWindow: () => Promise<void>;
    closeModelDropdown: () => Promise<void>;
    toggleModelDropdown: () => Promise<void>;
    openHistoryDialog: () => Promise<void>;
    startNewSession: () => Promise<void>;
    toggleWindowPin: () => Promise<void>;
    toggleWindowMaximize: () => Promise<void>;
    handleSubmit: (query: string) => Promise<void>;
    clearAll: () => void;
    cancelRequest: () => void;
    clearSession: () => void;
}

const DOUBLE_BACKSPACE_INTERVAL = 300;

function createEmptyModelOverride(): SearchModelOverride {
    return {
        modelId: null,
        providerId: null,
    };
}

/**
 * 搜索交互共享上下文。
 */
export function createSearchInteractionContext() {
    const state = reactive<SearchInteractionContextState>({
        activationEpoch: 0,
        activationSource: 'unknown',
        visibilityEpoch: 0,
        windowVisible: true,
        windowFocused: false,
        appFocused: true,
        lastHideReason: null,
        entryCheckArmedVisibilityEpoch: null,
        lastEntryCheckedVisibilityEpoch: null,
        timeoutClearArmedVisibilityEpoch: null,
        lastHideAt: null,
        isPinned: false,
        activePopupType: null,
        activePopupIdentity: null,
    });

    function recordActivation(activationSource: SearchActivationSource) {
        state.activationEpoch += 1;
        state.activationSource = activationSource;
        state.windowVisible = true;
    }

    function markWindowHidden(input: MarkWindowHiddenInput) {
        state.windowVisible = false;
        state.windowFocused = false;
        state.visibilityEpoch += 1;
        state.lastHideReason = input.hideReason;
        state.activationSource = 'unknown';
        state.entryCheckArmedVisibilityEpoch = state.visibilityEpoch;
        state.lastEntryCheckedVisibilityEpoch = null;

        if (input.hideReason === 'app-blur-hide') {
            state.timeoutClearArmedVisibilityEpoch = state.visibilityEpoch;
            state.lastHideAt = input.hiddenAt;
            return;
        }

        state.timeoutClearArmedVisibilityEpoch = null;
        state.lastHideAt = null;
    }

    function markWindowVisible() {
        state.windowVisible = true;
    }

    function setWindowFocused(windowFocused: boolean) {
        state.windowFocused = windowFocused;
    }

    function setAppFocused(appFocused: boolean) {
        state.appFocused = appFocused;
    }

    function markEntryChecked(visibilityEpoch: number) {
        state.lastEntryCheckedVisibilityEpoch = visibilityEpoch;
    }

    function shouldRunTimeoutClearOnFocus(visibilityEpoch: number, now: number, timeoutMs = 0) {
        if (
            state.timeoutClearArmedVisibilityEpoch !== visibilityEpoch ||
            state.lastHideAt === null
        ) {
            return false;
        }

        state.timeoutClearArmedVisibilityEpoch = null;
        const shouldRun = now - state.lastHideAt >= timeoutMs;
        if (shouldRun) {
            state.lastHideAt = null;
        }
        return shouldRun;
    }

    function setActivePopupSession(input: {
        popupType: SearchPopupSurfaceType;
        identity: SearchPopupSessionIdentity;
    }) {
        state.activePopupType = input.popupType;
        state.activePopupIdentity = input.identity;
    }

    function clearActivePopupSession() {
        state.activePopupType = null;
        state.activePopupIdentity = null;
    }

    return {
        state,
        recordActivation,
        markWindowHidden,
        markWindowVisible,
        setWindowFocused,
        setAppFocused,
        markEntryChecked,
        shouldRunTimeoutClearOnFocus,
        setActivePopupSession,
        clearActivePopupSession,
    };
}

/**
 * 搜索入口资格策略。
 */
export function createSearchEntryPolicy() {
    const state = reactive({
        consumedSnapshotIds: new Set<string>(),
    });

    function shouldCheckShortcutEntry(input: ShouldCheckShortcutEntryInput) {
        return (
            input.activationSource === 'shortcut' &&
            input.entryCheckArmedVisibilityEpoch === input.visibilityEpoch &&
            input.lastEntryCheckedVisibilityEpoch !== input.visibilityEpoch
        );
    }

    function shouldConsumeSnapshot(snapshotId: string | null | undefined) {
        return typeof snapshotId === 'string' && snapshotId.length > 0
            ? !state.consumedSnapshotIds.has(snapshotId)
            : false;
    }

    function markSnapshotConsumed(snapshotId: string | null | undefined) {
        if (!snapshotId) {
            return;
        }

        state.consumedSnapshotIds.add(snapshotId);
    }

    return {
        state,
        shouldCheckShortcutEntry,
        shouldConsumeSnapshot,
        markSnapshotConsumed,
    };
}

/**
 * popup surface 协调器。
 */
export function createPopupSurfaceCoordinator(
    interactionContext: Pick<
        ReturnType<typeof createSearchInteractionContext>,
        'state' | 'setActivePopupSession' | 'clearActivePopupSession'
    >
) {
    const state = interactionContext.state;

    function activatePopup(input: {
        popupId: string;
        popupType: SearchPopupSurfaceType;
        windowLabel: string;
        popupSessionVersion: number;
    }) {
        interactionContext.setActivePopupSession({
            popupType: input.popupType,
            identity: {
                popupId: input.popupId,
                windowLabel: input.windowLabel,
                popupSessionVersion: input.popupSessionVersion,
            },
        });
    }

    function clearActivePopup() {
        interactionContext.clearActivePopupSession();
    }

    function isCurrentPopupEvent(input: PopupSessionEventIdentity) {
        if (!state.activePopupIdentity) {
            return false;
        }

        return (
            state.activePopupIdentity.popupId === input.popupId &&
            state.activePopupIdentity.windowLabel === input.windowLabel &&
            state.activePopupIdentity.popupSessionVersion === input.popupSessionVersion
        );
    }

    return {
        state,
        activatePopup,
        clearActivePopup,
        isCurrentPopupEvent,
    };
}

/**
 * SearchView 中的 QuickSearch 协调层。
 * 负责集中判断何时允许展示 QuickSearch，并通过页面 controller
 * 统一驱动面板打开、关闭和结果刷新。
 */
export function useQuickSearchCoordinator(options: UseQuickSearchCoordinatorOptions) {
    const {
        queryText,
        attachments,
        sessionHistory,
        cursorContext,
        modelOverride,
        modelDropdownState,
        quickSearchOpen,
        controller,
        suppressNextAutoOpen,
    } = options;

    const isQuickSearchOpen = computed(() => {
        return quickSearchOpen.value;
    });

    function shouldTriggerQuickSearch(query: string) {
        return (
            sessionHistory.value.length === 0 &&
            !modelDropdownState.value.isOpen &&
            !!query.trim() &&
            !cursorContext.value.isMultiLine &&
            !modelOverride.value.modelId &&
            attachments.value.length === 0
        );
    }

    function syncQuickSearchPanel(query = queryText.value) {
        if (suppressNextAutoOpen?.value) {
            suppressNextAutoOpen.value = false;
            controller.closeQuickSearch();
            return;
        }

        if (shouldTriggerQuickSearch(query)) {
            controller.triggerQuickSearch(query);
            return;
        }

        controller.closeQuickSearch();
    }

    watch(
        () => ({
            query: queryText.value,
            attachmentCount: attachments.value.length,
            sessionCount: sessionHistory.value.length,
            isMultiLine: cursorContext.value.isMultiLine,
            selectedModelId: modelOverride.value.modelId,
            isModelDropdownOpen: modelDropdownState.value.isOpen,
        }),
        ({ query }) => {
            syncQuickSearchPanel(query);
        },
        { flush: 'post' }
    );

    return {
        isQuickSearchOpen,
        shouldTriggerQuickSearch,
        syncQuickSearchPanel,
    };
}

/**
 * 搜索页浮层状态机。
 * 负责 QuickSearch 与模型下拉等各类模块状态切换过程。
 */
export function useSearchOverlayMachine(options: UseSearchOverlayMachineOptions) {
    const { isQuickSearchOpen, modelDropdownState } = options;
    const overlayState = ref<SearchOverlayState>('idle');

    function syncOverlayState(options: SyncOverlayStateOptions = {}) {
        if (
            !options.force &&
            (overlayState.value === 'model-dropdown-preparing' ||
                overlayState.value === 'waiting-layout-stable')
        ) {
            return;
        }

        if (modelDropdownState.value.isOpen) {
            overlayState.value = 'model-dropdown-open';
            return;
        }

        overlayState.value = isQuickSearchOpen.value ? 'quick-search-open' : 'idle';
    }

    function requestModelDropdownOpen(): SearchOverlayCommand {
        if (
            modelDropdownState.value.isOpen ||
            overlayState.value === 'model-dropdown-preparing' ||
            overlayState.value === 'waiting-layout-stable'
        ) {
            return 'noop';
        }

        overlayState.value = 'model-dropdown-preparing';
        return isQuickSearchOpen.value ? 'close-quick-search' : 'open-model-dropdown';
    }

    function handleQuickSearchClosedForModelDropdown(): SearchOverlayCommand {
        if (overlayState.value !== 'model-dropdown-preparing') {
            return 'noop';
        }

        overlayState.value = 'waiting-layout-stable';
        return 'wait-layout-stable';
    }

    function handleLayoutStableForModelDropdown(): SearchOverlayCommand {
        if (overlayState.value !== 'waiting-layout-stable') {
            return 'noop';
        }

        return 'open-model-dropdown';
    }

    function handleModelDropdownOpened() {
        overlayState.value = 'model-dropdown-open';
    }

    function handleModelDropdownClosed() {
        syncOverlayState({ force: true });
    }

    watch(
        () => [isQuickSearchOpen.value, modelDropdownState.value.isOpen],
        () => {
            syncOverlayState();
        },
        { immediate: true, flush: 'sync' }
    );

    return {
        overlayState,
        requestModelDropdownOpen,
        handleQuickSearchClosedForModelDropdown,
        handleLayoutStableForModelDropdown,
        handleModelDropdownOpened,
        handleModelDropdownClosed,
        syncOverlayState,
    };
}

/**
 * 在同步键盘路由中启动可能异步的副作用。
 */
function runKeyboardEffect(effect: () => void | Promise<void>) {
    void Promise.resolve(effect()).catch((error) => {
        console.error('[SearchKeyboardRouter] Failed to handle keyboard effect:', error);
    });
}

/**
 * 判断审批态下是否属于“误输入”。
 */
function isTypingAttemptDuringApproval(input: SearchKeyboardRouteInput) {
    if (input.ctrlKey || input.metaKey || input.altKey) {
        return false;
    }

    return input.key.length === 1 || input.key === 'Backspace' || input.key === 'Delete';
}

/**
 * 判断是否命中 Ctrl/Cmd 主修饰键快捷键。
 */
function resolvePrimaryShortcutKey(
    input: SearchKeyboardRouteInput,
    queryText: string,
    isLoading: boolean
): SearchPrimaryShortcutKey | null {
    const hasPrimaryModifier = input.ctrlKey || input.metaKey;
    if (!hasPrimaryModifier || input.altKey || input.shiftKey) {
        return null;
    }

    const normalizedKey = input.key.toLowerCase();
    if (normalizedKey === '.') {
        return isLoading ? '.' : null;
    }

    if (normalizedKey === 'backspace') {
        return queryText.trim() ? 'backspace' : null;
    }

    if (['h', 'l', 'n', 'm', 'p'].includes(normalizedKey)) {
        return normalizedKey as SearchPrimaryShortcutKey;
    }

    return null;
}

/**
 * 纯键盘语义路由器。
 */
export function createSearchKeyboardRouter(options: CreateSearchKeyboardRouterOptions) {
    const {
        getPendingApproval,
        getActiveSurface,
        hasActivePopupWindowFocus,
        getQueryText,
        isQuickSearchOpen,
        hasQuickSearchHighlight,
        shouldTriggerQuickSearch,
        isMultiLineCursor,
        hasModelOverride,
        getSessionHistoryCount,
        isLoading,
        onPromptApprovalAttention,
        onRejectApproval,
        onApproveApproval,
        onForwardToPopup,
        onSubmit,
        onOpenQuickSearch,
        onMoveQuickSearchSelection,
        onOpenHighlightedQuickSearchItem,
        onCloseQuickSearch,
        onHideAllPopups,
        onCancelRequest,
        onClearModelOverride,
        onHideWindow,
        onClearSession,
        onClearDraft,
        onClearAll,
        onPrimaryShortcut,
    } = options;

    function route(input: SearchKeyboardRouteInput) {
        const queryText = getQueryText();
        const pendingApproval = getPendingApproval();
        if (pendingApproval) {
            if (input.key === 'Escape' || input.key === 'Esc') {
                onRejectApproval(pendingApproval.callId);
                return true;
            }

            if (input.key === 'Enter') {
                if (!input.shiftKey && Date.now() >= pendingApproval.keyboardApproveAt) {
                    onApproveApproval(pendingApproval.callId);
                } else {
                    onPromptApprovalAttention();
                }
                return true;
            }

            if (isTypingAttemptDuringApproval(input)) {
                onPromptApprovalAttention();
                return true;
            }
        }

        const primaryShortcut = resolvePrimaryShortcutKey(input, queryText, isLoading());
        if (primaryShortcut) {
            runKeyboardEffect(() => onPrimaryShortcut(primaryShortcut));
            return true;
        }

        if (hasActivePopupWindowFocus()) {
            return true;
        }

        if (input.key === 'Escape' || input.key === 'Esc') {
            if (getActiveSurface() !== 'search-surface') {
                runKeyboardEffect(onHideAllPopups);
                return true;
            }

            if (isLoading()) {
                onCancelRequest();
                return true;
            }

            // Step 1: Clear input text first without exiting the current conversation
            if (queryText.trim()) {
                onClearDraft();
                return true;
            }

            // Step 2: Clear model selection
            if (hasModelOverride()) {
                onClearModelOverride();
                return true;
            }

            // Step 3: Exit conversation if session exists
            if (getSessionHistoryCount() > 0) {
                onClearSession();
                return true;
            }

            // Step 4: Hide window if no session
            runKeyboardEffect(onHideWindow);
            return true;
        }

        if (
            getActiveSurface() === 'model-dropdown-surface' &&
            ['ArrowUp', 'ArrowDown', 'Enter'].includes(input.key)
        ) {
            onForwardToPopup(input.key);
            return true;
        }

        if (isQuickSearchOpen()) {
            if (hasQuickSearchHighlight()) {
                const directionMap: Partial<Record<string, SearchQuickSearchDirection>> = {
                    ArrowUp: 'up',
                    ArrowDown: 'down',
                    ArrowLeft: 'left',
                    ArrowRight: 'right',
                };
                const direction = directionMap[input.key];
                if (direction) {
                    onMoveQuickSearchSelection(direction);
                    return true;
                }

                if (input.key === 'Enter') {
                    runKeyboardEffect(onOpenHighlightedQuickSearchItem);
                    return true;
                }
            } else {
                if (input.key === 'ArrowDown') {
                    onMoveQuickSearchSelection('down');
                    return true;
                }

                if (input.key === 'Enter' && !input.shiftKey) {
                    onCloseQuickSearch();
                    if (queryText.trim()) {
                        runKeyboardEffect(onSubmit);
                    }
                    return true;
                }
            }
        }

        if (getActiveSurface() === 'search-surface' && !isQuickSearchOpen()) {
            if (input.key === 'ArrowDown') {
                if (!shouldTriggerQuickSearch(queryText)) {
                    return false;
                }

                onOpenQuickSearch();
                return true;
            }

            if (input.key === 'ArrowUp') {
                if (isMultiLineCursor()) {
                    return false;
                }

                if (queryText.trim()) {
                    runKeyboardEffect(onSubmit);
                }
                return true;
            }
        }

        if (getActiveSurface() === 'search-surface' && input.key === 'Enter' && !input.shiftKey) {
            if (queryText.trim()) {
                runKeyboardEffect(onSubmit);
            }
            return true;
        }

        return false;
    }

    return {
        route,
    };
}

/**
 * 创建 SearchView 页面级键盘处理器。
 */
export function createSearchKeydownHandler(options: UseSearchKeyboardOptions) {
    const {
        viewReady,
        queryText,
        cursorContext,
        modelOverride,
        modelDropdownState,
        controller,
        sessionHistory,
        pendingRequest,
        isWaitingForCompletion,
        isLoading,
        pendingToolApproval,
        approvePendingToolApproval,
        rejectPendingToolApproval,
        promptPendingToolApprovalAttention,
        getActivePopupType,
        hasActivePopupWindowFocus,
        isQuickSearchOpen,
        shouldTriggerQuickSearch,
        sessionHistoryPopupOpen,
        hideAllPopups,
        hideSearchWindow,
        closeModelDropdown,
        toggleModelDropdown,
        openHistoryDialog,
        startNewSession,
        toggleWindowPin,
        toggleWindowMaximize,
        handleSubmit,
        clearAll,
        cancelRequest,
        clearSession,
    } = options;

    let lastBackspaceTime = 0;
    const keyboardRouter = createSearchKeyboardRouter({
        getPendingApproval: () =>
            pendingToolApproval.value
                ? {
                      callId: pendingToolApproval.value.callId,
                      keyboardApproveAt: pendingToolApproval.value.keyboardApproveAt,
                  }
                : null,
        getActiveSurface: () => {
            const activePopupType = getActivePopupType();
            if (activePopupType) {
                return activePopupType;
            }
            if (sessionHistoryPopupOpen.value) {
                return 'session-history-surface';
            }
            if (modelDropdownState.value.isOpen) {
                return 'model-dropdown-surface';
            }
            return 'search-surface';
        },
        hasActivePopupWindowFocus,
        getQueryText: () => queryText.value,
        isQuickSearchOpen: () => isQuickSearchOpen.value,
        hasQuickSearchHighlight: () => controller.isQuickSearchItemHighlighted(),
        shouldTriggerQuickSearch,
        isMultiLineCursor: () => cursorContext.value.isMultiLine,
        hasModelOverride: () => Boolean(modelOverride.value.modelId),
        getSessionHistoryCount: () => sessionHistory.value.length,
        isLoading: () => isLoading.value,
        onPromptApprovalAttention: promptPendingToolApprovalAttention,
        onRejectApproval: rejectPendingToolApproval,
        onApproveApproval: approvePendingToolApproval,
        onForwardToPopup: (key) => {
            const payload: PopupKeydownPayload = {
                key,
                targetType: 'model-dropdown-popup',
            };
            void eventService.emit(AppEvent.POPUP_KEYDOWN, payload);
        },
        onSubmit: async () => {
            await handleSubmit(queryText.value);
        },
        onOpenQuickSearch: () => {
            controller.openQuickSearch();
        },
        onMoveQuickSearchSelection: (direction) => {
            controller.moveQuickSearchSelection(direction);
        },
        onOpenHighlightedQuickSearchItem: async () => {
            await controller.openHighlightedQuickSearchItem();
        },
        onCloseQuickSearch: () => {
            controller.closeQuickSearch();
        },
        onHideAllPopups: async () => {
            await hideAllPopups();
        },
        onCancelRequest: () => {
            cancelRequest();
        },
        onClearModelOverride: () => {
            modelOverride.value = createEmptyModelOverride();
        },
        onHideWindow: async () => {
            await hideSearchWindow();
        },
        onClearSession: () => {
            clearSession();
        },
        onClearDraft: () => {
            queryText.value = '';
        },
        onClearAll: () => {
            clearAll();
        },
        onPrimaryShortcut: async (key) => {
            if (key === 'h') {
                await openHistoryDialog();
                return;
            }

            if (key === 'l') {
                await hideAllPopups();
                await controller.focusSearchInput();
                return;
            }

            if (key === 'n') {
                if (sessionHistory.value.length > 0) {
                    await startNewSession();
                }
                return;
            }

            if (key === 'm') {
                await toggleModelDropdown();
                return;
            }

            if (key === 'p') {
                await toggleWindowPin();
                return;
            }

            if (key === '.') {
                cancelRequest();
                return;
            }

            clearAll();
        },
    });

    return async function handleKeyDown(event: KeyboardEvent) {
        if (!viewReady.value) {
            return;
        }

        if (event.defaultPrevented) {
            return;
        }

        if (event.key === 'F11') {
            event.preventDefault();
            event.stopPropagation();
            await toggleWindowMaximize();
            return;
        }

        const handledByRouter = keyboardRouter.route({
            key: event.key,
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
        });
        if (handledByRouter) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        if (event.key === 'Tab' && sessionHistory.value.length > 0) {
            event.preventDefault();
            controller.focusConversation();
            return;
        }

        if (event.key === 'Backspace') {
            if (modelDropdownState.value.isOpen) {
                await closeModelDropdown();
                return;
            }

            if (pendingRequest.value) {
                const now = Date.now();
                const timeSinceLastBackspace = now - lastBackspaceTime;
                lastBackspaceTime = now;

                if (timeSinceLastBackspace < DOUBLE_BACKSPACE_INTERVAL) {
                    event.preventDefault();
                    pendingRequest.value = null;
                    isWaitingForCompletion.value = false;
                    lastBackspaceTime = 0;
                }
                return;
            }

            if (modelOverride.value.modelId && cursorContext.value.cursorAtStart) {
                event.preventDefault();
                modelOverride.value = createEmptyModelOverride();
            }
        }
    };
}
