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

    it('lets modified typing attempts bypass pending approval attention', () => {
        const { router, callbacks } = createKeyboardRouter({
            getPendingApproval: () => ({
                callId: 'approval-3',
                keyboardApproveAt: Date.now() + 5_000,
            }),
            getSearchKeybindings: () => ({
                ...createDefaultSearchKeybindings(),
                'search.history.open': 'Alt+X',
            }),
        });

        expect(router.route({ key: 'x', altKey: true })).toBe(true);

        expect(callbacks.onPromptApprovalAttention).not.toHaveBeenCalled();
        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledWith('search.history.open');
    });

    it('treats Backspace and Delete as typing attempts during pending approval', () => {
        const { router, callbacks } = createKeyboardRouter({
            getPendingApproval: () => ({
                callId: 'approval-4',
                keyboardApproveAt: Date.now() + 5_000,
            }),
        });

        expect(router.route({ key: 'Backspace' })).toBe(true);
        expect(router.route({ key: 'Delete' })).toBe(true);
        expect(router.route({ key: 'Enter', shiftKey: true })).toBe(true);

        expect(callbacks.onPromptApprovalAttention).toHaveBeenCalledTimes(3);
        expect(callbacks.onApproveApproval).not.toHaveBeenCalled();
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

    it('routes the model toggle shortcut only through the current keybinding configuration', async () => {
        const defaultRouter = createKeyboardRouter();
        expect(defaultRouter.router.route({ key: 'm', ctrlKey: true })).toBe(true);
        await flushAsyncWork();
        expect(defaultRouter.callbacks.onSearchKeybindingAction).toHaveBeenCalledWith(
            'search.model.toggle'
        );

        const disabledRouter = createKeyboardRouter({
            getSearchKeybindings: () => ({
                ...createDefaultSearchKeybindings(),
                'search.model.toggle': null,
            }),
        });
        expect(disabledRouter.router.route({ key: 'm', ctrlKey: true })).toBe(false);
        await flushAsyncWork();
        expect(disabledRouter.callbacks.onSearchKeybindingAction).not.toHaveBeenCalled();

        const remappedRouter = createKeyboardRouter({
            getSearchKeybindings: () => ({
                ...createDefaultSearchKeybindings(),
                'search.history.open': 'Mod+M',
                'search.model.toggle': null,
            }),
        });
        expect(remappedRouter.router.route({ key: 'm', ctrlKey: true })).toBe(true);
        await flushAsyncWork();
        expect(remappedRouter.callbacks.onSearchKeybindingAction).toHaveBeenCalledWith(
            'search.history.open'
        );
    });

    it('routes host accelerator commands only when the action still owns the shortcut', async () => {
        const disabledRouter = createKeyboardRouter({
            getSearchKeybindings: () => ({
                ...createDefaultSearchKeybindings(),
                'search.model.toggle': null,
            }),
        });

        expect(disabledRouter.router.routeCommand('search.model.toggle', 'Mod+M')).toBe(false);
        await flushAsyncWork();
        expect(disabledRouter.callbacks.onSearchKeybindingAction).not.toHaveBeenCalled();

        const remappedRouter = createKeyboardRouter({
            getSearchKeybindings: () => ({
                ...createDefaultSearchKeybindings(),
                'search.history.open': 'Mod+M',
                'search.model.toggle': null,
            }),
        });

        expect(remappedRouter.router.routeCommand('search.model.toggle', 'Mod+M')).toBe(false);
        await flushAsyncWork();
        expect(remappedRouter.callbacks.onSearchKeybindingAction).not.toHaveBeenCalled();

        expect(remappedRouter.router.routeCommand('search.history.open', 'Mod+M')).toBe(true);
        await flushAsyncWork();
        expect(remappedRouter.callbacks.onSearchKeybindingAction).toHaveBeenCalledWith(
            'search.history.open'
        );
    });

    it('swallows host accelerator shortcuts while a popup window has focus', async () => {
        const { router, callbacks } = createKeyboardRouter({
            hasActivePopupWindowFocus: () => true,
        });

        expect(router.routeCommand('search.model.toggle', 'Mod+M')).toBe(true);
        await flushAsyncWork();

        expect(callbacks.onSearchKeybindingAction).not.toHaveBeenCalled();
    });

    it('routes function-row search shortcuts by keyboard code when the key value is remapped', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getSearchKeybindings: () => ({
                ...createDefaultSearchKeybindings(),
                'search.history.open': 'F2',
            }),
        });

        expect(router.route({ key: 'BrightnessUp', code: 'F2' })).toBe(true);
        await flushAsyncWork();

        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledWith('search.history.open');
    });

    it('does not route Ctrl+Up through default search shortcuts or input history', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getSearchKeybindings: () => createDefaultSearchKeybindings(),
        });

        expect(router.route({ key: 'ArrowUp', ctrlKey: true })).toBe(false);
        await flushAsyncWork();

        expect(callbacks.onSearchKeybindingAction).not.toHaveBeenCalled();
        expect(callbacks.onNavigateInputHistory).not.toHaveBeenCalled();
    });

    it('routes the default maximize shortcut through the action callback', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getSearchKeybindings: () => createDefaultSearchKeybindings(),
        });

        expect(router.route({ key: 'F11' })).toBe(true);
        await flushAsyncWork();

        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledWith('search.window.maximize');
    });

    it('routes the default settings shortcut through the action callback', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getSearchKeybindings: () => createDefaultSearchKeybindings(),
        });

        expect(router.route({ key: ',', ctrlKey: true })).toBe(true);
        await flushAsyncWork();

        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledWith('search.settings.open');
    });

    it('routes the default settings shortcut when IME remaps the key value to Process', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getSearchKeybindings: () => createDefaultSearchKeybindings(),
        });

        expect(router.route({ key: 'Process', code: 'Comma', ctrlKey: true })).toBe(true);
        await flushAsyncWork();

        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledWith('search.settings.open');
    });

    it('routes the default reopen-last-closed-session shortcut through the action callback', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getSearchKeybindings: () => createDefaultSearchKeybindings(),
        });

        expect(router.route({ key: 't', ctrlKey: true, shiftKey: true })).toBe(true);
        await flushAsyncWork();

        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledWith(
            'search.session.reopenLastClosed'
        );
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

    it('swallows keyboard effects that reject after routing a shortcut', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const rejection = new Error('shortcut side effect failed');
        const { router, callbacks } = createKeyboardRouter({
            getSearchKeybindings: () => ({
                ...createDefaultSearchKeybindings(),
                'search.history.open': 'Mod+Y',
            }),
            onSearchKeybindingAction: vi.fn().mockRejectedValue(rejection),
        });

        expect(router.route({ key: 'y', ctrlKey: true })).toBe(true);
        await flushAsyncWork();

        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledWith('search.history.open');
        expect(errorSpy).toHaveBeenCalledWith(
            '[SearchKeyboardRouter] Failed to handle keyboard effect:',
            rejection
        );
    });

    it('consumes keys while a popup window owns focus', () => {
        const { router, callbacks } = createKeyboardRouter({
            hasActivePopupWindowFocus: () => true,
        });

        expect(router.route({ key: 'A' })).toBe(true);

        expect(callbacks.onSubmit).not.toHaveBeenCalled();
        expect(callbacks.onOpenQuickSearch).not.toHaveBeenCalled();
    });

    it('does not route search shortcuts while a popup window owns focus', async () => {
        const { router, callbacks } = createKeyboardRouter({
            hasActivePopupWindowFocus: () => true,
        });

        expect(router.route({ key: 'F11' })).toBe(true);
        expect(router.route({ key: 'h', ctrlKey: true })).toBe(true);
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

    it('collapses highlighted quick search on escape before closing surfaces', () => {
        const { router, callbacks } = createKeyboardRouter({
            isQuickSearchOpen: () => true,
            hasQuickSearchHighlight: () => true,
        });

        expect(router.route({ key: 'Esc' })).toBe(true);

        expect(callbacks.onQuickSearchCollapse).toHaveBeenCalledTimes(1);
        expect(callbacks.onHideWindow).not.toHaveBeenCalled();
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

    it('routes quick-search page and menu keys', () => {
        const { router, callbacks } = createKeyboardRouter({
            isQuickSearchOpen: () => true,
            hasQuickSearchHighlight: () => false,
        });

        expect(router.route({ key: 'PageUp' })).toBe(true);
        expect(router.route({ key: 'PageDown' })).toBe(true);
        expect(router.route({ key: 'ContextMenu' })).toBe(true);
        expect(router.route({ key: 'F10', shiftKey: true })).toBe(true);

        expect(callbacks.onQuickSearchPageUp).toHaveBeenCalledTimes(1);
        expect(callbacks.onQuickSearchPageDown).toHaveBeenCalledTimes(1);
        expect(callbacks.onQuickSearchContextMenu).toHaveBeenCalledTimes(2);
    });

    it('routes quick-search view toggle through the current keybinding configuration', async () => {
        const { router, callbacks } = createKeyboardRouter({
            isQuickSearchOpen: () => true,
            hasQuickSearchHighlight: () => false,
        });

        expect(router.route({ key: 'g', ctrlKey: true })).toBe(true);
        await flushAsyncWork();
        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledWith(
            'search.quickSearch.toggleView'
        );

        const disabledRouter = createKeyboardRouter({
            isQuickSearchOpen: () => true,
            getSearchKeybindings: () => ({
                ...createDefaultSearchKeybindings(),
                'search.quickSearch.toggleView': null,
            }),
        });
        expect(disabledRouter.router.route({ key: 'g', ctrlKey: true })).toBe(false);
        await flushAsyncWork();
        expect(disabledRouter.callbacks.onSearchKeybindingAction).not.toHaveBeenCalled();

        const closedRouter = createKeyboardRouter({
            isQuickSearchOpen: () => false,
        });
        expect(closedRouter.router.route({ key: 'g', ctrlKey: true })).toBe(false);
        await flushAsyncWork();
        expect(closedRouter.callbacks.onSearchKeybindingAction).not.toHaveBeenCalled();
    });

    it('routes highlighted quick-search navigation and opening through the quick-search contract', async () => {
        const { router, callbacks } = createKeyboardRouter({
            isQuickSearchOpen: () => true,
            hasQuickSearchHighlight: () => true,
        });

        expect(router.route({ key: 'ArrowUp' })).toBe(true);
        expect(router.route({ key: 'ArrowDown' })).toBe(true);
        expect(router.route({ key: 'ArrowLeft' })).toBe(true);
        expect(router.route({ key: 'ArrowRight' })).toBe(true);
        expect(router.route({ key: 'Enter' })).toBe(true);
        await flushAsyncWork();

        expect(callbacks.onMoveQuickSearchSelection).toHaveBeenNthCalledWith(1, 'up');
        expect(callbacks.onMoveQuickSearchSelection).toHaveBeenNthCalledWith(2, 'down');
        expect(callbacks.onMoveQuickSearchSelection).toHaveBeenNthCalledWith(3, 'left');
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

    it('closes unhighlighted quick search on enter without submitting empty text', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getQueryText: () => '   ',
            isQuickSearchOpen: () => true,
            hasQuickSearchHighlight: () => false,
        });

        expect(router.route({ key: 'Enter' })).toBe(true);
        expect(router.route({ key: 'Enter', shiftKey: true })).toBe(false);
        await flushAsyncWork();

        expect(callbacks.onCloseQuickSearch).toHaveBeenCalledTimes(1);
        expect(callbacks.onSubmit).not.toHaveBeenCalled();
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

    it('uses newer input-history navigation before quick-search fallback on ArrowDown', async () => {
        const historyRouter = createKeyboardRouter({
            onNavigateInputHistory: vi.fn(() => 'navigated' as const),
            shouldTriggerQuickSearch: vi.fn(() => true),
        });
        expect(historyRouter.router.route({ key: 'ArrowDown' })).toBe(true);
        expect(historyRouter.callbacks.onNavigateInputHistory).toHaveBeenCalledWith('newer');
        expect(historyRouter.callbacks.onOpenQuickSearch).not.toHaveBeenCalled();

        const multilineRouter = createKeyboardRouter({
            isMultiLineCursor: () => true,
            isCursorAtEnd: () => false,
        });
        expect(multilineRouter.router.route({ key: 'ArrowDown' })).toBe(false);
        expect(multilineRouter.callbacks.onNavigateInputHistory).not.toHaveBeenCalled();

        const noTriggerRouter = createKeyboardRouter({
            shouldTriggerQuickSearch: vi.fn(() => false),
        });
        expect(noTriggerRouter.router.route({ key: 'ArrowDown' })).toBe(false);
        expect(noTriggerRouter.callbacks.onOpenQuickSearch).not.toHaveBeenCalled();
        await flushAsyncWork();
    });

    it('submits query text or attachments from ArrowDown quick-search fallback', async () => {
        const queryRouter = createKeyboardRouter({
            getQueryText: () => 'touch',
            shouldTriggerQuickSearch: () => true,
        });
        expect(queryRouter.router.route({ key: 'ArrowDown' })).toBe(true);
        await flushAsyncWork();
        expect(queryRouter.callbacks.onSubmit).toHaveBeenCalledTimes(1);

        const attachmentRouter = createKeyboardRouter({
            hasAttachments: () => true,
            shouldTriggerQuickSearch: () => true,
        });
        expect(attachmentRouter.router.route({ key: 'ArrowDown' })).toBe(true);
        await flushAsyncWork();
        expect(attachmentRouter.callbacks.onSubmit).toHaveBeenCalledTimes(1);
    });

    it('handles Enter on the search surface for text, attachments, and empty drafts', async () => {
        const queryRouter = createKeyboardRouter({
            getQueryText: () => 'touch',
        });
        expect(queryRouter.router.route({ key: 'Enter' })).toBe(true);
        await flushAsyncWork();
        expect(queryRouter.callbacks.onSubmit).toHaveBeenCalledTimes(1);

        const attachmentRouter = createKeyboardRouter({
            hasAttachments: () => true,
        });
        expect(attachmentRouter.router.route({ key: 'Enter' })).toBe(true);
        await flushAsyncWork();
        expect(attachmentRouter.callbacks.onSubmit).toHaveBeenCalledTimes(1);

        const emptyRouter = createKeyboardRouter();
        expect(emptyRouter.router.route({ key: 'Enter' })).toBe(true);
        await flushAsyncWork();
        expect(emptyRouter.callbacks.onSubmit).not.toHaveBeenCalled();

        const shiftedRouter = createKeyboardRouter({
            getQueryText: () => 'touch',
        });
        expect(shiftedRouter.router.route({ key: 'Enter', shiftKey: true })).toBe(false);
        await flushAsyncWork();
        expect(shiftedRouter.callbacks.onSubmit).not.toHaveBeenCalled();
    });
});
