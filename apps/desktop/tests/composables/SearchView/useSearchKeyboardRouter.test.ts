import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultSearchKeybindings } from '@/config/searchKeybindings';
import { createSearchKeyboardRouter } from '@/views/SearchView/composables/interaction/useSearchKeyboardRouter';

async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
}

function createKeyboardRouter(
    overrides: Partial<Parameters<typeof createSearchKeyboardRouter>[0]> = {}
) {
    const defaultCallbacks = {
        onPromptApprovalAttention: vi.fn(),
        onRejectApproval: vi.fn(),
        onApproveApproval: vi.fn(),
        onForwardToPopup: vi.fn(),
        onSubmit: vi.fn(),
        onOpenQuickSearch: vi.fn(),
        onMoveQuickSearchSelection: vi.fn(),
        onOpenHighlightedQuickSearchItem: vi.fn(),
        onCloseQuickSearch: vi.fn(),
        onQuickSearchPageUp: vi.fn(),
        onQuickSearchPageDown: vi.fn(),
        onQuickSearchContextMenu: vi.fn(),
        onQuickSearchToggleView: vi.fn(),
        onQuickSearchCollapse: vi.fn(),
        onNavigateInputHistory: vi.fn(() => 'ignored' as const),
        onHideAllPopups: vi.fn(),
        onCancelRequest: vi.fn(),
        onClearModelOverride: vi.fn(),
        onHideWindow: vi.fn(),
        onClearSession: vi.fn(),
        onClearDraft: vi.fn(),
        onClearAll: vi.fn(),
        onSearchKeybindingAction: vi.fn(),
    };
    const routerOptions = {
        getSearchKeybindings: () => createDefaultSearchKeybindings(),
        getPendingApproval: () => null,
        getActiveSurface: () => 'search-surface' as const,
        hasActivePopupWindowFocus: () => false,
        getQueryText: () => '',
        hasAttachments: () => false,
        isQuickSearchOpen: () => false,
        hasQuickSearchHighlight: () => false,
        shouldTriggerQuickSearch: () => false,
        isMultiLineCursor: () => false,
        isCursorAtTextStart: () => true,
        isCursorAtEnd: () => true,
        hasModelOverride: () => false,
        getSessionHistoryCount: () => 0,
        isLoading: () => false,
        ...defaultCallbacks,
        ...overrides,
    };

    return {
        callbacks: routerOptions,
        router: createSearchKeyboardRouter(routerOptions),
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

    it('routes configurable command shortcuts through the action callback', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getSearchKeybindings: () => ({
                ...createDefaultSearchKeybindings(),
                'search.history.open': 'Mod+Y',
            }),
        });

        expect(router.route({ key: 'y', ctrlKey: true })).toBe(true);
        await flushAsyncWork();

        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledWith('search.history.open');
    });

    it('routes the default Ctrl+Up shortcut through the action callback', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getSearchKeybindings: () => createDefaultSearchKeybindings(),
        });

        expect(router.route({ key: 'ArrowUp', ctrlKey: true })).toBe(true);
        await flushAsyncWork();

        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledWith(
            'search.session.reopenLastClosed'
        );
    });

    it('routes the default maximize shortcut through the action callback', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getSearchKeybindings: () => createDefaultSearchKeybindings(),
        });

        expect(router.route({ key: 'F11' })).toBe(true);
        await flushAsyncWork();

        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledWith('search.window.maximize');
    });

    it('stops routing raw F11 after the maximize shortcut is remapped', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getSearchKeybindings: () => ({
                ...createDefaultSearchKeybindings(),
                'search.window.maximize': 'F12',
            }),
        });

        expect(router.route({ key: 'F11' })).toBe(false);
        expect(router.route({ key: 'F12' })).toBe(true);
        await flushAsyncWork();

        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledTimes(1);
        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledWith('search.window.maximize');
    });

    it('does not route removed Ctrl+. and Ctrl+Backspace shortcuts', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getSearchKeybindings: () => createDefaultSearchKeybindings(),
            getQueryText: () => 'touchai',
            isLoading: () => true,
        });

        expect(router.route({ key: 'Backspace', ctrlKey: true })).toBe(false);
        expect(router.route({ key: '.', ctrlKey: true })).toBe(false);
        expect(router.route({ key: '.', ctrlKey: true, shiftKey: true })).toBe(false);
        await flushAsyncWork();

        expect(callbacks.onSearchKeybindingAction).not.toHaveBeenCalled();
    });

    it('applies the escape fallback order on the search surface', async () => {
        const loadingRouter = createKeyboardRouter({
            isLoading: () => true,
        });
        expect(loadingRouter.router.route({ key: 'Escape' })).toBe(true);
        expect(loadingRouter.callbacks.onCancelRequest).toHaveBeenCalledTimes(1);
        expect(loadingRouter.callbacks.onClearDraft).not.toHaveBeenCalled();

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
            getQueryText: () => '',
            shouldTriggerQuickSearch: () => true,
        });
        expect(openRouter.router.route({ key: 'ArrowDown' })).toBe(true);
        expect(openRouter.callbacks.onOpenQuickSearch).toHaveBeenCalledTimes(1);
    });

    it('uses input-history navigation for ArrowUp and leaves multiline editing alone', async () => {
        const singleLineRouter = createKeyboardRouter({
            getQueryText: () => 'submit me',
            isMultiLineCursor: () => false,
            isCursorAtTextStart: () => true,
            onNavigateInputHistory: vi.fn(() => 'navigated' as const),
        });
        expect(singleLineRouter.router.route({ key: 'ArrowUp' })).toBe(true);
        expect(singleLineRouter.callbacks.onNavigateInputHistory).toHaveBeenCalledWith('older');

        const multiLineRouter = createKeyboardRouter({
            getQueryText: () => 'keep editing',
            isMultiLineCursor: () => true,
            isCursorAtTextStart: () => false,
        });
        expect(multiLineRouter.router.route({ key: 'ArrowUp' })).toBe(false);
        expect(multiLineRouter.callbacks.onNavigateInputHistory).not.toHaveBeenCalled();
        await flushAsyncWork();
    });
});
