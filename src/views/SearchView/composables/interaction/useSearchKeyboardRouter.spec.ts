import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSearchKeyboardRouter } from './useSearchKeyboardRouter';

async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
}

function createKeyboardRouter(
    overrides: Partial<Parameters<typeof createSearchKeyboardRouter>[0]> = {}
) {
    const callbacks = {
        onPromptApprovalAttention: vi.fn(),
        onRejectApproval: vi.fn(),
        onApproveApproval: vi.fn(),
        onForwardToPopup: vi.fn(),
        onSubmit: vi.fn(),
        onOpenQuickSearch: vi.fn(),
        onMoveQuickSearchSelection: vi.fn(),
        onOpenHighlightedQuickSearchItem: vi.fn(),
        onCloseQuickSearch: vi.fn(),
        onHideAllPopups: vi.fn(),
        onCancelRequest: vi.fn(),
        onClearModelOverride: vi.fn(),
        onHideWindow: vi.fn(),
        onClearSession: vi.fn(),
        onClearDraft: vi.fn(),
        onClearAll: vi.fn(),
        onPrimaryShortcut: vi.fn(),
    };

    return {
        callbacks,
        router: createSearchKeyboardRouter({
            getPendingApproval: () => null,
            getActiveSurface: () => 'search-surface',
            hasActivePopupWindowFocus: () => false,
            getQueryText: () => '',
            isQuickSearchOpen: () => false,
            hasQuickSearchHighlight: () => false,
            shouldTriggerQuickSearch: () => false,
            isMultiLineCursor: () => false,
            hasModelOverride: () => false,
            getSessionHistoryCount: () => 0,
            isLoading: () => false,
            ...callbacks,
            ...overrides,
        }),
    };
}

describe('createSearchKeyboardRouter', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('rejects pending approvals with escape before normal surface handling', () => {
        const { router, callbacks } = createKeyboardRouter({
            getPendingApproval: () => ({
                callId: 'approval-1',
                keyboardApproveAt: Date.now() + 5_000,
            }),
        });

        const handled = router.route({ key: 'Escape' });

        expect(handled).toBe(true);
        expect(callbacks.onRejectApproval).toHaveBeenCalledWith('approval-1');
    });

    it('gates approval enter and typing until the keyboard approval deadline passes', () => {
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100);
        const { router, callbacks } = createKeyboardRouter({
            getPendingApproval: () => ({
                callId: 'approval-2',
                keyboardApproveAt: 200,
            }),
        });

        expect(router.route({ key: 'Enter' })).toBe(true);
        expect(router.route({ key: 'x' })).toBe(true);
        expect(callbacks.onPromptApprovalAttention).toHaveBeenCalledTimes(2);
        expect(callbacks.onApproveApproval).not.toHaveBeenCalled();

        nowSpy.mockReturnValue(300);
        expect(router.route({ key: 'Enter' })).toBe(true);
        expect(callbacks.onApproveApproval).toHaveBeenCalledWith('approval-2');
    });

    it('runs primary shortcuts only when their guard conditions are satisfied', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getQueryText: () => 'touchai',
            isLoading: () => true,
        });

        expect(router.route({ key: 'Backspace', ctrlKey: true })).toBe(true);
        expect(router.route({ key: '.', ctrlKey: true })).toBe(true);
        expect(router.route({ key: '.', ctrlKey: true, shiftKey: true })).toBe(false);
        await flushAsyncWork();

        expect(callbacks.onPrimaryShortcut).toHaveBeenNthCalledWith(1, 'backspace');
        expect(callbacks.onPrimaryShortcut).toHaveBeenNthCalledWith(2, '.');
    });

    it('applies the escape fallback order on the search surface', async () => {
        const draftRouter = createKeyboardRouter({
            getQueryText: () => 'current draft',
        });
        expect(draftRouter.router.route({ key: 'Escape' })).toBe(true);
        expect(draftRouter.callbacks.onClearDraft).toHaveBeenCalledTimes(1);
        expect(draftRouter.callbacks.onClearModelOverride).not.toHaveBeenCalled();

        const modelRouter = createKeyboardRouter({
            hasModelOverride: () => true,
        });
        expect(modelRouter.router.route({ key: 'Escape' })).toBe(true);
        expect(modelRouter.callbacks.onClearModelOverride).toHaveBeenCalledTimes(1);
        expect(modelRouter.callbacks.onClearSession).not.toHaveBeenCalled();

        const sessionRouter = createKeyboardRouter({
            getSessionHistoryCount: () => 2,
        });
        expect(sessionRouter.router.route({ key: 'Escape' })).toBe(true);
        expect(sessionRouter.callbacks.onClearSession).toHaveBeenCalledTimes(1);
        expect(sessionRouter.callbacks.onHideWindow).not.toHaveBeenCalled();

        const emptyRouter = createKeyboardRouter();
        expect(emptyRouter.router.route({ key: 'Escape' })).toBe(true);
        await flushAsyncWork();
        expect(emptyRouter.callbacks.onHideWindow).toHaveBeenCalledTimes(1);
    });

    it('hides popup surfaces with escape and forwards model dropdown navigation keys', async () => {
        const popupRouter = createKeyboardRouter({
            getActiveSurface: () => 'model-dropdown-surface',
        });

        expect(popupRouter.router.route({ key: 'Escape' })).toBe(true);
        await flushAsyncWork();
        expect(popupRouter.callbacks.onHideAllPopups).toHaveBeenCalledTimes(1);

        const dropdownRouter = createKeyboardRouter({
            getActiveSurface: () => 'model-dropdown-surface',
        });

        expect(dropdownRouter.router.route({ key: 'ArrowDown' })).toBe(true);
        expect(dropdownRouter.router.route({ key: 'Enter' })).toBe(true);
        expect(dropdownRouter.callbacks.onForwardToPopup).toHaveBeenNthCalledWith(1, 'ArrowDown');
        expect(dropdownRouter.callbacks.onForwardToPopup).toHaveBeenNthCalledWith(2, 'Enter');
    });

    it('routes highlighted quick-search navigation and opening through the quick-search contract', async () => {
        const { router, callbacks } = createKeyboardRouter({
            isQuickSearchOpen: () => true,
            hasQuickSearchHighlight: () => true,
        });

        expect(router.route({ key: 'ArrowRight' })).toBe(true);
        expect(router.route({ key: 'Enter' })).toBe(true);
        await flushAsyncWork();

        expect(callbacks.onMoveQuickSearchSelection).toHaveBeenCalledWith('right');
        expect(callbacks.onOpenHighlightedQuickSearchItem).toHaveBeenCalledTimes(1);
    });

    it('handles unhighlighted quick-search enter/down actions before returning to search-surface routing', async () => {
        const quickSearchRouter = createKeyboardRouter({
            getQueryText: () => 'touch',
            isQuickSearchOpen: () => true,
            hasQuickSearchHighlight: () => false,
        });

        expect(quickSearchRouter.router.route({ key: 'ArrowDown' })).toBe(true);
        expect(quickSearchRouter.router.route({ key: 'Enter' })).toBe(true);
        await flushAsyncWork();

        expect(quickSearchRouter.callbacks.onMoveQuickSearchSelection).toHaveBeenCalledWith('down');
        expect(quickSearchRouter.callbacks.onCloseQuickSearch).toHaveBeenCalledTimes(1);
        expect(quickSearchRouter.callbacks.onSubmit).toHaveBeenCalledTimes(1);

        const openRouter = createKeyboardRouter({
            getQueryText: () => 'touch',
            shouldTriggerQuickSearch: () => true,
        });
        expect(openRouter.router.route({ key: 'ArrowDown' })).toBe(true);
        expect(openRouter.callbacks.onOpenQuickSearch).toHaveBeenCalledTimes(1);
    });

    it('submits ArrowUp on a single-line cursor and leaves multiline editing alone', async () => {
        const singleLineRouter = createKeyboardRouter({
            getQueryText: () => 'submit me',
            isMultiLineCursor: () => false,
        });
        expect(singleLineRouter.router.route({ key: 'ArrowUp' })).toBe(true);
        await flushAsyncWork();
        expect(singleLineRouter.callbacks.onSubmit).toHaveBeenCalledTimes(1);

        const multiLineRouter = createKeyboardRouter({
            getQueryText: () => 'keep editing',
            isMultiLineCursor: () => true,
        });
        expect(multiLineRouter.router.route({ key: 'ArrowUp' })).toBe(false);
        expect(multiLineRouter.callbacks.onSubmit).not.toHaveBeenCalled();
    });
});
