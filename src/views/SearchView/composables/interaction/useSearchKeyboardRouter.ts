import type { SearchPopupSurfaceType } from '../searchInteraction';

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
        onPrimaryShortcut,
    } = options;

    /**
     * 根据当前 surface 和审批状态解释一次键盘输入。
     */
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
