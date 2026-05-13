import { describe, expect, it, vi } from 'vitest';

import { createSearchKeyboardRouter } from './searchInteraction';

function createRouterState() {
    return {
        queryText: '',
        hasDraftContent: false,
        hasModelOverride: false,
        sessionHistoryCount: 0,
        isLoading: false,
        activeSurface: 'search-surface' as const,
    };
}

function createRouter(state = createRouterState()) {
    const handlers = {
        promptApprovalAttention: vi.fn(),
        rejectApproval: vi.fn(),
        approveApproval: vi.fn(),
        forwardToPopup: vi.fn(),
        submit: vi.fn(),
        openQuickSearch: vi.fn(),
        moveQuickSearchSelection: vi.fn(),
        openHighlightedQuickSearchItem: vi.fn(),
        closeQuickSearch: vi.fn(),
        hideAllPopups: vi.fn(),
        cancelRequest: vi.fn(),
        clearDraft: vi.fn(() => {
            state.queryText = '';
            state.hasDraftContent = false;
        }),
        clearModelOverride: vi.fn(() => {
            state.hasModelOverride = false;
        }),
        hideWindow: vi.fn(),
        clearSession: vi.fn(() => {
            state.sessionHistoryCount = 0;
        }),
        primaryShortcut: vi.fn(),
    };

    const router = createSearchKeyboardRouter({
        getPendingApproval: () => null,
        getActiveSurface: () => state.activeSurface,
        hasActivePopupWindowFocus: () => false,
        getQueryText: () => state.queryText,
        hasDraftContent: () => state.hasDraftContent,
        isQuickSearchOpen: () => false,
        hasQuickSearchHighlight: () => false,
        shouldTriggerQuickSearch: () => false,
        isMultiLineCursor: () => false,
        hasModelOverride: () => state.hasModelOverride,
        getSessionHistoryCount: () => state.sessionHistoryCount,
        isLoading: () => state.isLoading,
        onPromptApprovalAttention: handlers.promptApprovalAttention,
        onRejectApproval: handlers.rejectApproval,
        onApproveApproval: handlers.approveApproval,
        onForwardToPopup: handlers.forwardToPopup,
        onSubmit: handlers.submit,
        onOpenQuickSearch: handlers.openQuickSearch,
        onMoveQuickSearchSelection: handlers.moveQuickSearchSelection,
        onOpenHighlightedQuickSearchItem: handlers.openHighlightedQuickSearchItem,
        onCloseQuickSearch: handlers.closeQuickSearch,
        onHideAllPopups: handlers.hideAllPopups,
        onCancelRequest: handlers.cancelRequest,
        onClearDraft: handlers.clearDraft,
        onClearModelOverride: handlers.clearModelOverride,
        onHideWindow: handlers.hideWindow,
        onClearSession: handlers.clearSession,
        onPrimaryShortcut: handlers.primaryShortcut,
    });

    return {
        router,
        state,
        handlers,
    };
}

describe('createSearchKeyboardRouter', () => {
    it('clears draft before model override or conversation session on Escape', () => {
        const { router, handlers } = createRouter({
            ...createRouterState(),
            queryText: 'hello',
            hasDraftContent: true,
            hasModelOverride: true,
            sessionHistoryCount: 2,
        });

        expect(router.route({ key: 'Escape' })).toBe(true);

        expect(handlers.clearDraft).toHaveBeenCalledOnce();
        expect(handlers.clearModelOverride).not.toHaveBeenCalled();
        expect(handlers.clearSession).not.toHaveBeenCalled();
        expect(handlers.hideWindow).not.toHaveBeenCalled();
    });

    it('clears model override before exiting an active conversation on Escape', () => {
        const { router, handlers } = createRouter({
            ...createRouterState(),
            hasModelOverride: true,
            sessionHistoryCount: 2,
        });

        expect(router.route({ key: 'Escape' })).toBe(true);

        expect(handlers.clearModelOverride).toHaveBeenCalledOnce();
        expect(handlers.clearSession).not.toHaveBeenCalled();
        expect(handlers.hideWindow).not.toHaveBeenCalled();
    });

    it('exits the active conversation after draft and model override are clear on Escape', () => {
        const { router, handlers } = createRouter({
            ...createRouterState(),
            sessionHistoryCount: 2,
        });

        expect(router.route({ key: 'Escape' })).toBe(true);

        expect(handlers.clearSession).toHaveBeenCalledOnce();
        expect(handlers.hideWindow).not.toHaveBeenCalled();
    });
});
