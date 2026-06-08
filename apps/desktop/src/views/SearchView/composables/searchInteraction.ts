/**
 * SearchView 交互语义层。
 * 收口页面交互状态、QuickSearch / overlay 策略与键盘语义解释，
 * 避免页面编排层和输入层同时承载交互规则。
 */
import { AppEvent, eventService } from '@services/EventService';
import type { PopupKeydownPayload } from '@services/PopupService';
import { computed, type ComputedRef, reactive, type Ref, ref, watch } from 'vue';

import type { SearchKeybindings } from '@/config/searchKeybindings';
import { useAskUserStore } from '@/stores/askUser';
import {
    cloneInputHistorySnapshot,
    createInputHistorySnapshot,
    hasInputHistorySnapshotContent,
    type InputHistorySnapshot,
    type PendingToolApproval,
    type SessionMessage,
} from '@/types/session';

import type {
    PendingRequest,
    SearchCursorContext,
    SearchModelDropdownState,
    SearchModelOverride,
    SearchOverlayState,
    SearchPageController,
} from '../types';
import { createSearchKeyboardRouter as createConfigurableSearchKeyboardRouter } from './interaction/useSearchKeyboardRouter';

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

export type SessionInputHistoryDirection = 'older' | 'newer';
export type SessionInputHistoryNavigationResult = 'navigated' | 'blocked' | 'ignored';

export interface UseSearchKeyboardOptions {
    viewReady: Ref<boolean>;
    searchKeybindings: Readonly<Ref<SearchKeybindings>>;
    queryText: Ref<string>;
    attachments: Ref<unknown[]>;
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
    navigateInputHistory: (
        direction: SessionInputHistoryDirection
    ) => SessionInputHistoryNavigationResult;
    closeModelDropdown: () => Promise<void>;
    toggleModelDropdown: () => Promise<void>;
    openHistoryDialog: () => Promise<void>;
    startNewSession: () => Promise<void>;
    reopenLastClosedSession: () => Promise<void>;
    toggleWindowPin: () => Promise<void>;
    toggleWindowMaximize: () => Promise<void>;
    handleSubmit: (query: string) => Promise<void>;
    cancelRequest: () => void;
    clearSession: () => void;
}

function createEmptyModelOverride(): SearchModelOverride {
    return {
        modelId: null,
        providerId: null,
    };
}

export interface SessionInputHistoryBrowseState {
    pointer: number;
    draftBeforeBrowse: InputHistorySnapshot | null;
    activeBrowseSnapshot: InputHistorySnapshot | null;
}

export interface NavigateSessionInputHistoryOptions {
    entries: InputHistorySnapshot[];
    currentDraft: InputHistorySnapshot;
    direction: SessionInputHistoryDirection;
    state: SessionInputHistoryBrowseState;
}

export interface NavigateSessionInputHistoryResult {
    changed: boolean;
    nextSnapshot: InputHistorySnapshot;
    state: SessionInputHistoryBrowseState;
}

/**
 * 从当前会话消息中提取可用于输入历史导航的 user prompt 列表。
 *
 * 该列表保持原始发送顺序，允许重复内容；
 * 仅收集显式允许进入输入历史的 user prompt。
 */
export function extractSessionInputHistoryEntries(
    messages: SessionMessage[]
): InputHistorySnapshot[] {
    return messages
        .map((message) => ({
            message,
            snapshot: createInputHistorySnapshot({
                text: message.inputSnapshot?.text ?? message.content,
                attachments: message.inputSnapshot?.attachments ?? message.attachments ?? [],
                editorDoc: message.inputSnapshot?.editorDoc,
                excludeFromHistory: message.inputSnapshot?.excludeFromHistory,
            }),
        }))
        .filter(({ message, snapshot }) => {
            return (
                message.role === 'user' &&
                snapshot.excludeFromHistory !== true &&
                hasInputHistorySnapshotContent(snapshot)
            );
        })
        .map(({ snapshot }) => snapshot);
}

export function createSessionInputHistoryBrowseState(
    entryCount = 0
): SessionInputHistoryBrowseState {
    return {
        pointer: entryCount,
        draftBeforeBrowse: null,
        activeBrowseSnapshot: null,
    };
}

/**
 * 在输入历史中前后导航。
 *
 * `pointer === entries.length` 表示“最新位置”，也就是未浏览历史时的尾位置；
 * 进入历史浏览的第一步会先缓存当前草稿，向下浏览回到尾位置时再恢复该草稿。
 */
export function navigateSessionInputHistory(
    options: NavigateSessionInputHistoryOptions
): NavigateSessionInputHistoryResult {
    const { entries, currentDraft, direction } = options;
    const latestPointer = entries.length;
    const currentPointer = Math.min(Math.max(options.state.pointer, 0), latestPointer);
    const currentBrowseSnapshot =
        cloneInputHistorySnapshot(options.state.activeBrowseSnapshot) ??
        (currentPointer < latestPointer
            ? cloneInputHistorySnapshot(entries[currentPointer])
            : null);

    if (entries.length === 0) {
        return {
            changed: false,
            nextSnapshot: createInputHistorySnapshot(currentDraft),
            state: createSessionInputHistoryBrowseState(latestPointer),
        };
    }

    if (direction === 'older') {
        if (currentPointer === 0) {
            return {
                changed: false,
                nextSnapshot:
                    currentBrowseSnapshot ??
                    cloneInputHistorySnapshot(entries[0]) ??
                    createInputHistorySnapshot(currentDraft),
                state: {
                    pointer: 0,
                    draftBeforeBrowse: cloneInputHistorySnapshot(options.state.draftBeforeBrowse),
                    activeBrowseSnapshot: currentBrowseSnapshot,
                },
            };
        }

        const nextPointer =
            currentPointer === latestPointer ? latestPointer - 1 : currentPointer - 1;
        const nextSnapshot =
            cloneInputHistorySnapshot(entries[nextPointer]) ??
            createInputHistorySnapshot(currentDraft);
        return {
            changed: true,
            nextSnapshot,
            state: {
                pointer: nextPointer,
                draftBeforeBrowse:
                    currentPointer === latestPointer
                        ? createInputHistorySnapshot(currentDraft)
                        : cloneInputHistorySnapshot(options.state.draftBeforeBrowse),
                activeBrowseSnapshot: nextSnapshot,
            },
        };
    }

    if (currentPointer === latestPointer) {
        return {
            changed: false,
            nextSnapshot: createInputHistorySnapshot(currentDraft),
            state: {
                pointer: latestPointer,
                draftBeforeBrowse: cloneInputHistorySnapshot(options.state.draftBeforeBrowse),
                activeBrowseSnapshot: null,
            },
        };
    }

    const nextPointer = Math.min(latestPointer, currentPointer + 1);
    const nextSnapshot =
        nextPointer === latestPointer
            ? (cloneInputHistorySnapshot(options.state.draftBeforeBrowse) ??
              createInputHistorySnapshot({
                  text: '',
                  attachments: [],
              }))
            : (cloneInputHistorySnapshot(entries[nextPointer]) ??
              createInputHistorySnapshot(currentDraft));
    return {
        changed: true,
        nextSnapshot,
        state: {
            pointer: nextPointer,
            draftBeforeBrowse: cloneInputHistorySnapshot(options.state.draftBeforeBrowse),
            activeBrowseSnapshot: nextPointer === latestPointer ? null : nextSnapshot,
        },
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
        state.timeoutClearArmedVisibilityEpoch = state.visibilityEpoch;
        state.lastHideAt = input.hiddenAt;
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

    function isCurrentPopupEvent(input: SearchPopupSessionIdentity) {
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
 * 创建 SearchView 页面级键盘处理器。
 */
export function createSearchKeydownHandler(options: UseSearchKeyboardOptions) {
    const {
        viewReady,
        searchKeybindings,
        queryText,
        attachments,
        cursorContext,
        modelOverride,
        modelDropdownState,
        controller,
        sessionHistory,
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
        navigateInputHistory,
        closeModelDropdown,
        toggleModelDropdown,
        openHistoryDialog,
        startNewSession,
        reopenLastClosedSession,
        toggleWindowPin,
        toggleWindowMaximize,
        handleSubmit,
        cancelRequest,
        clearSession,
    } = options;

    const keyboardRouter = createConfigurableSearchKeyboardRouter({
        getSearchKeybindings: () => searchKeybindings.value,
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
        hasAttachments: () => attachments.value.length > 0,
        isQuickSearchOpen: () => isQuickSearchOpen.value,
        hasQuickSearchHighlight: () => controller.isQuickSearchItemHighlighted(),
        shouldTriggerQuickSearch,
        isMultiLineCursor: () => cursorContext.value.isMultiLine,
        isCursorAtTextStart: () => cursorContext.value.cursorAtTextStart,
        isCursorAtEnd: () => cursorContext.value.cursorAtEnd,
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
        onQuickSearchPageUp: () => {
            controller.goToPreviousPageQuickSearch();
        },
        onQuickSearchPageDown: () => {
            controller.goToNextPageQuickSearch();
        },
        onQuickSearchContextMenu: () => {
            controller.openQuickSearchContextMenu();
        },
        onQuickSearchToggleView: () => {
            controller.toggleQuickSearchView();
        },
        onQuickSearchCollapse: () => {
            controller.collapseQuickSearch();
        },
        onNavigateInputHistory: (direction) => {
            return navigateInputHistory(direction);
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
        onSearchKeybindingAction: async (actionId) => {
            switch (actionId) {
                case 'search.history.open':
                    await openHistoryDialog();
                    return;
                case 'search.input.focus':
                    await hideAllPopups();
                    await controller.focusSearchInput();
                    return;
                case 'search.session.new':
                    if (sessionHistory.value.length > 0) {
                        await startNewSession();
                    }
                    return;
                case 'search.session.reopenLastClosed':
                    await reopenLastClosedSession();
                    return;
                case 'search.model.toggle':
                    await toggleModelDropdown();
                    return;
                case 'search.window.pin':
                    await toggleWindowPin();
                    return;
                case 'search.window.maximize':
                    await toggleWindowMaximize();
                    return;
                default: {
                    const exhaustiveActionId: never = actionId;
                    throw new Error(`Unhandled search keybinding action: ${exhaustiveActionId}`);
                }
            }
        },
    });

    const askUserStore = useAskUserStore();

    return async function handleKeyDown(event: KeyboardEvent) {
        if (!viewReady.value) {
            return;
        }

        // AskUserPanel 接管所有键盘——面板自己在 window 上挂了 capture listener
        if (askUserStore.current) {
            return;
        }

        // 右键菜单打开时，Escape 关闭菜单，其它键不拦截。
        if (controller.isQuickSearchContextMenuOpen()) {
            if (event.key === 'Escape' || event.key === 'Esc') {
                controller.closeQuickSearchContextMenu();
                event.preventDefault();
                event.stopPropagation();
            }
            // 非 Escape 键不拦截，传播到 useContextMenu 的 document listener 处理上下键导航。
            return;
        }

        if (event.defaultPrevented) {
            return;
        }

        const handledByRouter = keyboardRouter.route({
            key: event.key,
            code: event.code,
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

            if (modelOverride.value.modelId && cursorContext.value.cursorAtStart) {
                event.preventDefault();
                modelOverride.value = createEmptyModelOverride();
            }
        }
    };
}
