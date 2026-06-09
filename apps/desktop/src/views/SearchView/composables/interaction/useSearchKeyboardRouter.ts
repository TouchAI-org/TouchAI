import type { SearchKeybindingActionId, SearchKeybindings } from '@/config/searchKeybindings';
import { matchShortcut } from '@/utils/shortcuts';

export type SearchPopupSurfaceType = 'model-dropdown-surface' | 'session-history-surface';
type SearchKeyboardSurface = 'search-surface' | SearchPopupSurfaceType;
type SearchQuickSearchDirection = 'up' | 'down' | 'left' | 'right';
export type SessionInputHistoryDirection = 'older' | 'newer';
export type SessionInputHistoryNavigationResult = 'navigated' | 'blocked' | 'ignored';

interface PendingApprovalState {
    callId?: string;
    keyboardApproveAt: number;
}

export interface SearchKeyboardRouteInput {
    key: string;
    code?: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
}

interface CreateSearchKeyboardRouterOptions {
    getSearchKeybindings: () => SearchKeybindings;
    getPendingApproval: () => PendingApprovalState | null;
    getActiveSurface: () => SearchKeyboardSurface;
    hasActivePopupWindowFocus: () => boolean;
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
    onForwardToPopup: (key: string) => void;
    onSubmit: () => void | Promise<void>;
    onOpenQuickSearch: () => void;
    onMoveQuickSearchSelection: (direction: SearchQuickSearchDirection) => void;
    onOpenHighlightedQuickSearchItem: () => void | Promise<void>;
    onCloseQuickSearch: () => void;
    onQuickSearchPageUp: () => void;
    onQuickSearchPageDown: () => void;
    onQuickSearchContextMenu: () => void;
    onQuickSearchToggleView: () => void;
    onQuickSearchCollapse: () => void;
    onNavigateInputHistory: (
        direction: SessionInputHistoryDirection
    ) => SessionInputHistoryNavigationResult;
    onHideAllPopups: () => void | Promise<void>;
    onCancelRequest: () => void;
    onClearModelOverride: () => void;
    onHideWindow: () => void | Promise<void>;
    onClearSession: () => void;
    onClearDraft: () => void;
    onSearchKeybindingAction: (actionId: SearchKeybindingActionId) => void | Promise<void>;
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

function hasNavigationModifier(input: SearchKeyboardRouteInput) {
    return Boolean(input.ctrlKey || input.metaKey || input.altKey || input.shiftKey);
}

function resolveSearchKeybindingAction(
    input: SearchKeyboardRouteInput,
    keybindings: SearchKeybindings
): SearchKeybindingActionId | null {
    for (const [actionId, shortcut] of Object.entries(keybindings) as Array<
        [SearchKeybindingActionId, string | null]
    >) {
        if (!matchShortcut(shortcut, input)) {
            continue;
        }

        return actionId;
    }

    return null;
}

/**
 * 纯键盘语义路由器。
 */
export function createSearchKeyboardRouter(options: CreateSearchKeyboardRouterOptions) {
    const {
        getSearchKeybindings,
        getPendingApproval,
        getActiveSurface,
        hasActivePopupWindowFocus,
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
        onForwardToPopup,
        onSubmit,
        onOpenQuickSearch,
        onMoveQuickSearchSelection,
        onOpenHighlightedQuickSearchItem,
        onCloseQuickSearch,
        onQuickSearchPageUp,
        onQuickSearchPageDown,
        onQuickSearchContextMenu,
        onQuickSearchToggleView,
        onQuickSearchCollapse,
        onNavigateInputHistory,
        onHideAllPopups,
        onCancelRequest,
        onClearModelOverride,
        onHideWindow,
        onClearSession,
        onClearDraft,
        onSearchKeybindingAction,
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

        if (hasActivePopupWindowFocus()) {
            return true;
        }

        const searchKeybindingAction = resolveSearchKeybindingAction(input, getSearchKeybindings());
        if (searchKeybindingAction) {
            runKeyboardEffect(() => onSearchKeybindingAction(searchKeybindingAction));
            return true;
        }

        if (input.key === 'Escape' || input.key === 'Esc') {
            if (isQuickSearchOpen() && hasQuickSearchHighlight()) {
                onQuickSearchCollapse();
                return true;
            }

            if (getActiveSurface() !== 'search-surface') {
                runKeyboardEffect(onHideAllPopups);
                return true;
            }

            if (isLoading()) {
                onCancelRequest();
                return true;
            }

            if (queryText.trim()) {
                onClearDraft();
                return true;
            }

            if (hasModelOverride()) {
                onClearModelOverride();
                return true;
            }

            if (getSessionHistoryCount() > 0) {
                onClearSession();
                return true;
            }

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
            if (input.key === 'PageUp') {
                onQuickSearchPageUp();
                return true;
            }

            if (input.key === 'PageDown') {
                onQuickSearchPageDown();
                return true;
            }

            if (input.key === 'ContextMenu' || (input.key === 'F10' && input.shiftKey)) {
                onQuickSearchContextMenu();
                return true;
            }

            if (input.key.toLowerCase() === 'g' && (input.ctrlKey || input.metaKey)) {
                onQuickSearchToggleView();
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
                    onCloseQuickSearch();
                    if (queryText.trim()) {
                        runKeyboardEffect(onSubmit);
                    }
                    return true;
                }
            }
        }

        if (getActiveSurface() === 'search-surface' && !isQuickSearchOpen()) {
            if (input.key === 'ArrowUp') {
                if (hasNavigationModifier(input)) {
                    return false;
                }

                if (isMultiLineCursor() && !isCursorAtTextStart()) {
                    return false;
                }

                return onNavigateInputHistory('older') !== 'ignored';
            }

            if (input.key === 'ArrowDown') {
                if (hasNavigationModifier(input)) {
                    return false;
                }

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
    };
}
