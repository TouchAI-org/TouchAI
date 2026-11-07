/**
 * SearchView 交互语义层。
 * 收口页面交互状态、QuickSearch / overlay 策略与键盘语义解释，
 * 避免页面编排层和输入层同时承载交互规则。
 */
import type { SearchSurfaceCommandEvent } from '@services/EventService/types';
import { log } from '@services/ObservabilityService';
import { computed, type ComputedRef, reactive, type Ref, watch } from 'vue';

import type { SearchKeybindingActionId, SearchKeybindings } from '@/config/searchKeybindings';
import { useAskUserStore } from '@/stores/askUser';
import {
    cloneInputHistorySnapshot,
    createInputHistorySnapshot,
    hasInputHistorySnapshotContent,
    type InputHistorySnapshot,
    type PendingToolApproval,
    type SessionMessage,
} from '@/types/session';
import { matchShortcut, normalizeLocalShortcutString } from '@/utils/shortcuts';

import type {
    PendingRequest,
    SearchCursorContext,
    SearchModelDropdownState,
    SearchModelOverride,
    SearchPageController,
} from '../types';

export type SearchActivationSource = 'shortcut' | 'manual' | 'unknown';

export type SearchHideReason = 'app-blur-hide' | 'manual-dismiss' | 'policy-toggle-hide';

export type SearchOverlaySurfaceType = 'model-dropdown-surface' | 'session-history-surface';

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

export type SearchInteractionContextState = SearchActivationContextState;

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
    activeOverlay: Ref<'none' | 'model-dropdown' | 'session-history'>;
    quickSearchOpen: Ref<boolean>;
    /** Keep QuickSearch mounted while its surface hands off to the session panel. */
    quickSearchHandoff?: Readonly<Ref<boolean>>;
    controller: SearchPageController;
    suppressNextAutoOpen?: Ref<boolean>;
}

type SearchKeyboardSurface = 'search-surface' | SearchOverlaySurfaceType;
type SearchQuickSearchDirection = 'up' | 'down' | 'left' | 'right';
type SearchPrimaryShortcutKey = '.' | 'backspace';
export type SessionInputHistoryDirection = 'older' | 'newer';
export type SessionInputHistoryNavigationResult = 'navigated' | 'blocked' | 'ignored';

interface PendingApprovalState {
    callId?: string;
    keyboardApproveAt: number;
}

interface SearchKeyboardRouteInput {
    key: string;
    code?: string;
    repeat?: boolean;
    inlineOverlayInput?: boolean;
    keyCode?: number;
    isComposing?: boolean;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
}

interface CreateSearchKeyboardRouterOptions {
    cancelActivePanelInteraction?: () => boolean;
    getSearchKeybindings?: () => SearchKeybindings;
    getPendingApproval: () => PendingApprovalState | null;
    getActiveSurface: () => SearchKeyboardSurface;
    getQueryText: () => string;
    hasAttachments: () => boolean;
    isQuickSearchOpen: () => boolean;
    hasQuickSearchHighlight: () => boolean;
    shouldTriggerQuickSearch: (query: string) => boolean;
    isMultiLineCursor: () => boolean;
    isCursorAtTextStart: () => boolean;
    isCursorAtEnd: () => boolean;
    hasModelOverride: () => boolean;
    getSessionHistoryCount: () => number;
    isLoading: () => boolean;
    onPromptApprovalAttention: () => void;
    onRejectApproval: (callId?: string) => void;
    onApproveApproval: (callId?: string) => void;
    onForwardToOverlay: (key: string) => void;
    onSubmit: () => void | Promise<void>;
    onOpenQuickSearch: () => void;
    onMoveQuickSearchSelection: (direction: SearchQuickSearchDirection) => void;
    onOpenHighlightedQuickSearchItem: () => void | Promise<void>;
    onCloseQuickSearch: () => void;
    onQuickSearchPageUp: () => void;
    onQuickSearchPageDown: () => void;
    onQuickSearchContextMenu: () => void;
    onQuickSearchCollapse: () => void;
    onNavigateInputHistory: (
        direction: SessionInputHistoryDirection
    ) => SessionInputHistoryNavigationResult;
    onHideAllOverlays: () => void | Promise<void>;
    onCancelRequest: () => void;
    onClearModelOverride: () => void;
    onHideWindow: () => void | Promise<void>;
    onClearSession: () => void;
    onClearDraft: () => void;
    onPrimaryShortcut: (key: SearchPrimaryShortcutKey) => void | Promise<void>;
    onSearchKeybindingAction?: (actionId: SearchKeybindingActionId) => void | Promise<void>;
}

export interface UseSearchKeyboardOptions {
    cancelActivePanelInteraction?: () => boolean;
    searchKeybindings?: Readonly<Ref<SearchKeybindings>>;
    viewReady: Ref<boolean>;
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
    getActiveOverlaySurface: () => SearchOverlaySurfaceType | null;
    forwardOverlayKeydown?: (key: string) => void;
    isQuickSearchOpen: ComputedRef<boolean>;
    shouldTriggerQuickSearch: (query: string) => boolean;
    sessionHistoryOverlayOpen: Ref<boolean>;
    hideAllOverlays: () => Promise<void>;
    hideSearchWindow: () => Promise<void>;
    navigateInputHistory: (
        direction: SessionInputHistoryDirection
    ) => SessionInputHistoryNavigationResult;
    closeModelDropdown: () => Promise<void>;
    toggleWindowMaximize: () => Promise<void>;
    handleSubmit: (query: string) => Promise<void>;
    handleSearchKeybindingAction?: (actionId: SearchKeybindingActionId) => void | Promise<void>;
    clearAll: () => void;
    cancelRequest: () => void;
    clearSession: () => void;
}

export type SearchKeydownHandler = ((event: KeyboardEvent) => Promise<void>) & {
    routeSearchSurfaceCommand: (payload: SearchSurfaceCommandEvent) => boolean;
};

const DOUBLE_BACKSPACE_INTERVAL = 300;

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

    return {
        state,
        recordActivation,
        markWindowHidden,
        markWindowVisible,
        setWindowFocused,
        setAppFocused,
        markEntryChecked,
        shouldRunTimeoutClearOnFocus,
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
        activeOverlay,
        quickSearchOpen,
        controller,
        suppressNextAutoOpen,
    } = options;

    const isQuickSearchOpen = computed(() => {
        return quickSearchOpen.value;
    });

    /**
     * Whether the results list has anything to show for this query.
     *
     * This is about the query alone. Whether a popup is open belongs to the auto-open gate below:
     * the two were one predicate, so opening a popup also *closed* a list that was already showing
     * the user's results.
     */
    function shouldShowQuickSearch(query: string) {
        return (
            sessionHistory.value.length === 0 &&
            !!query.trim() &&
            !cursorContext.value.isMultiLine &&
            !modelOverride.value.modelId &&
            attachments.value.length === 0
        );
    }

    /** Auto-opening is what a popup suppresses; a list that is already open stays. */
    function shouldTriggerQuickSearch(query: string) {
        return (
            shouldShowQuickSearch(query) &&
            activeOverlay.value === 'none' &&
            !modelDropdownState.value.isOpen
        );
    }

    function syncQuickSearchPanel(query = queryText.value) {
        if (options.quickSearchHandoff?.value) {
            return;
        }

        if (suppressNextAutoOpen?.value) {
            suppressNextAutoOpen.value = false;
            controller.closeQuickSearch();
            return;
        }

        if (!shouldShowQuickSearch(query)) {
            controller.closeQuickSearch();
            return;
        }

        if (quickSearchOpen.value) {
            return;
        }

        if (shouldTriggerQuickSearch(query)) {
            controller.triggerQuickSearch(query);
        }
    }

    // The getter creates a new object even when a dependency is reassigned to
    // the same value. Skip those no-op syncs so hide cleanup cannot reopen a
    // settled Quick Search interaction.
    let lastQuickSearchSyncState: string | null = null;
    watch(
        () => ({
            query: queryText.value,
            attachmentCount: attachments.value.length,
            sessionCount: sessionHistory.value.length,
            isMultiLine: cursorContext.value.isMultiLine,
            selectedModelId: modelOverride.value.modelId,
            isModelDropdownOpen: modelDropdownState.value.isOpen,
            activeOverlay: activeOverlay.value,
            quickSearchHandoff: options.quickSearchHandoff?.value ?? false,
        }),
        (state) => {
            if (state.quickSearchHandoff) return;
            const nextState = JSON.stringify(state);
            if (nextState === lastQuickSearchSyncState) {
                return;
            }
            lastQuickSearchSyncState = nextState;
            syncQuickSearchPanel(state.query);
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
 * 在同步键盘路由中启动可能异步的副作用。
 */
function runKeyboardEffect(effect: () => void | Promise<void>) {
    void Promise.resolve(effect()).catch((error) => {
        log.error('[SearchKeyboardRouter] Failed to handle keyboard effect:', error);
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

function resolveSearchKeybindingAction(
    input: SearchKeyboardRouteInput,
    keybindings: SearchKeybindings
): SearchKeybindingActionId | null {
    for (const [actionId, shortcut] of Object.entries(keybindings) as Array<
        [SearchKeybindingActionId, string | null]
    >) {
        if (matchShortcut(shortcut, input)) {
            return actionId;
        }
    }

    return null;
}

function matchesSearchKeybindingCommand(
    actionId: SearchKeybindingActionId,
    shortcut: string,
    keybindings: SearchKeybindings
): boolean {
    const normalizedShortcut = normalizeLocalShortcutString(shortcut);
    if (!normalizedShortcut) {
        return false;
    }

    return normalizeLocalShortcutString(keybindings[actionId]) === normalizedShortcut;
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

    return null;
}

/**
 * 纯键盘语义路由器。
 */
export function createSearchKeyboardRouter(options: CreateSearchKeyboardRouterOptions) {
    const {
        cancelActivePanelInteraction,
        getSearchKeybindings,
        getPendingApproval,
        getActiveSurface,
        getQueryText,
        hasAttachments,
        isQuickSearchOpen,
        hasQuickSearchHighlight,
        shouldTriggerQuickSearch,
        isMultiLineCursor,
        isCursorAtTextStart,
        isCursorAtEnd,
        hasModelOverride,
        getSessionHistoryCount,
        isLoading,
        onPromptApprovalAttention,
        onRejectApproval,
        onApproveApproval,
        onForwardToOverlay,
        onSubmit,
        onOpenQuickSearch,
        onMoveQuickSearchSelection,
        onOpenHighlightedQuickSearchItem,
        onCloseQuickSearch,
        onQuickSearchPageUp,
        onQuickSearchPageDown,
        onQuickSearchContextMenu,
        onQuickSearchCollapse,
        onNavigateInputHistory,
        onHideAllOverlays,
        onCancelRequest,
        onClearModelOverride,
        onHideWindow,
        onClearSession,
        onClearDraft,
        onPrimaryShortcut,
        onSearchKeybindingAction,
    } = options;

    function routeSearchKeybindingAction(actionId: SearchKeybindingActionId) {
        if (!onSearchKeybindingAction) {
            return false;
        }

        if (actionId === 'search.quickSearch.toggleView' && !isQuickSearchOpen()) {
            return false;
        }

        runKeyboardEffect(() => onSearchKeybindingAction(actionId));
        return true;
    }

    function routeCommand(actionId: SearchKeybindingActionId, shortcut: string) {
        if (getPendingApproval()) {
            return true;
        }

        const keybindings = getSearchKeybindings?.();
        if (!keybindings || !matchesSearchKeybindingCommand(actionId, shortcut, keybindings)) {
            return false;
        }

        return routeSearchKeybindingAction(actionId);
    }

    function route(input: SearchKeyboardRouteInput) {
        if (input.isComposing || input.keyCode === 229) {
            return false;
        }

        if (
            input.repeat &&
            (['Escape', 'Esc'].includes(input.key) ||
                (input.key === 'Enter' && !input.shiftKey && !input.altKey))
        )
            return true;

        if ((input.key === 'Escape' || input.key === 'Esc') && cancelActivePanelInteraction?.()) {
            return true;
        }

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

        const keybindings = getSearchKeybindings?.();
        if (keybindings && onSearchKeybindingAction) {
            const actionId = resolveSearchKeybindingAction(input, keybindings);
            if (actionId) {
                if (pendingApproval || input.repeat) return true;
                return routeSearchKeybindingAction(actionId);
            }
        }

        const primaryShortcut = resolvePrimaryShortcutKey(input, queryText, isLoading());
        if (primaryShortcut && !(primaryShortcut === 'backspace' && input.inlineOverlayInput)) {
            runKeyboardEffect(() => onPrimaryShortcut(primaryShortcut));
            return true;
        }

        if (input.key === 'Escape' || input.key === 'Esc') {
            if (getActiveSurface() !== 'search-surface') {
                runKeyboardEffect(onHideAllOverlays);
                return true;
            }

            // 快速搜索有高亮时，Escape 只收缩面板、清除高亮，不走清空输入链路。
            if (isQuickSearchOpen() && hasQuickSearchHighlight()) {
                onQuickSearchCollapse();
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

        const modified = input.ctrlKey || input.metaKey || input.altKey || input.shiftKey;
        if (getActiveSurface() !== 'search-surface') {
            if (!modified && ['ArrowUp', 'ArrowDown', 'Enter'].includes(input.key)) {
                onForwardToOverlay(input.key);
                return true;
            }
            return false;
        }

        if (modified && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(input.key))
            return false;
        if (input.key === 'Enter' && (input.shiftKey || input.altKey)) return false;

        if (isQuickSearchOpen()) {
            // PageUp/PageDown 翻页
            if (input.key === 'PageUp') {
                onQuickSearchPageUp();
                return true;
            }
            if (input.key === 'PageDown') {
                onQuickSearchPageDown();
                return true;
            }

            // Menu 键或 Shift+F10 打开右键菜单
            if (input.key === 'ContextMenu' || (input.key === 'F10' && input.shiftKey)) {
                onQuickSearchContextMenu();
                return true;
            }

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
                    // Start submission before closing the panel. The submit path
                    // claims the native resize transaction synchronously; closing
                    // first lets ResizeObserver enqueue a stale shrink and causes
                    // the host to jump back to the compact height.
                    if (queryText.trim()) {
                        runKeyboardEffect(onSubmit);
                    } else {
                        onCloseQuickSearch();
                    }
                    return true;
                }
            }
        }

        if (getActiveSurface() === 'search-surface' && !isQuickSearchOpen()) {
            if (input.key === 'ArrowUp') {
                if (isMultiLineCursor() && !isCursorAtTextStart()) {
                    return false;
                }

                return onNavigateInputHistory('older') !== 'ignored';
            }

            if (input.key === 'ArrowDown') {
                if (isMultiLineCursor() && !isCursorAtEnd()) {
                    return false;
                }

                if (onNavigateInputHistory('newer') === 'navigated') {
                    return true;
                }

                if (!shouldTriggerQuickSearch(queryText)) {
                    return false;
                }

                if (queryText.trim() || hasAttachments()) {
                    runKeyboardEffect(onSubmit);
                    return true;
                }

                onOpenQuickSearch();
                return true;
            }
        }

        if (getActiveSurface() === 'search-surface' && input.key === 'Enter' && !input.shiftKey) {
            if (queryText.trim() || hasAttachments()) {
                runKeyboardEffect(onSubmit);
            }
            return true;
        }

        return false;
    }

    return {
        route,
        routeCommand,
    };
}

/**
 * 创建 SearchView 页面级键盘处理器。
 */
export function createSearchKeydownHandler(
    options: UseSearchKeyboardOptions
): SearchKeydownHandler {
    const {
        cancelActivePanelInteraction,
        viewReady,
        searchKeybindings,
        queryText,
        attachments,
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
        getActiveOverlaySurface,
        forwardOverlayKeydown,
        isQuickSearchOpen,
        shouldTriggerQuickSearch,
        sessionHistoryOverlayOpen,
        hideAllOverlays,
        hideSearchWindow,
        navigateInputHistory,
        closeModelDropdown,
        toggleWindowMaximize,
        handleSubmit,
        handleSearchKeybindingAction,
        clearAll,
        cancelRequest,
        clearSession,
    } = options;

    let lastBackspaceTime = 0;
    const keyboardRouter = createSearchKeyboardRouter({
        cancelActivePanelInteraction,
        getSearchKeybindings: searchKeybindings ? () => searchKeybindings.value : undefined,
        getPendingApproval: () =>
            pendingToolApproval.value
                ? {
                      callId: pendingToolApproval.value.callId,
                      keyboardApproveAt: pendingToolApproval.value.keyboardApproveAt,
                  }
                : null,
        getActiveSurface: () => {
            const activeOverlaySurface = getActiveOverlaySurface();
            if (activeOverlaySurface) {
                return activeOverlaySurface;
            }
            if (sessionHistoryOverlayOpen.value) {
                return 'session-history-surface';
            }
            if (modelDropdownState.value.isOpen) {
                return 'model-dropdown-surface';
            }
            return 'search-surface';
        },
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
        onForwardToOverlay: (key) => {
            forwardOverlayKeydown?.(key);
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
        onQuickSearchCollapse: () => {
            controller.collapseQuickSearch();
        },
        onNavigateInputHistory: (direction) => {
            return navigateInputHistory(direction);
        },
        onHideAllOverlays: async () => {
            await hideAllOverlays();
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
        onPrimaryShortcut: (key) => {
            if (key === '.') {
                cancelRequest();
                return;
            }

            clearAll();
        },
        onSearchKeybindingAction: handleSearchKeybindingAction,
    });

    const askUserStore = useAskUserStore();

    function shouldSkipSearchKeyboardRouting() {
        if (!viewReady.value) {
            return true;
        }

        if (askUserStore.current) {
            return true;
        }

        return controller.isQuickSearchContextMenuOpen();
    }

    function routeSearchSurfaceCommand(payload: SearchSurfaceCommandEvent) {
        if (shouldSkipSearchKeyboardRouting()) {
            return false;
        }

        return keyboardRouter.routeCommand(payload.actionId, payload.shortcut);
    }

    async function handleKeyDown(event: KeyboardEvent) {
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

        if (event.key === 'F11' && !searchKeybindings) {
            event.preventDefault();
            event.stopPropagation();
            await toggleWindowMaximize();
            return;
        }

        const eventTarget = event.target;
        const isInlineOverlayInput =
            (eventTarget instanceof HTMLInputElement ||
                eventTarget instanceof HTMLTextAreaElement) &&
            eventTarget.closest('[data-search-overlay-host="true"]') !== null;
        const handledByRouter = keyboardRouter.route({
            key: event.key,
            code: event.code,
            repeat: event.repeat,
            inlineOverlayInput: isInlineOverlayInput,
            keyCode: event.keyCode,
            isComposing: event.isComposing,
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

        if (isInlineOverlayInput) {
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
    }

    return Object.assign(handleKeyDown, {
        routeSearchSurfaceCommand,
    });
}
