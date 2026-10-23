import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createDefaultSearchKeybindings,
    type SearchKeybindingActionId,
    type SearchKeybindings,
} from '@/config/searchKeybindings';
import {
    createSearchKeyboardRouter,
    type SessionInputHistoryNavigationResult,
} from '@/views/SearchView/composables/interaction/useSearchKeyboardRouter';

type RouterOptions = Parameters<typeof createSearchKeyboardRouter>[0];

/**
 * Every observable action the router can hand to the page.
 * The router is the only place that decides which one a key press produces,
 * so the recorded journal IS the user-visible outcome of a key press.
 */
type RoutedEffect =
    | { type: 'prompt-approval-attention' }
    | { type: 'reject-approval'; callId?: string }
    | { type: 'approve-approval'; callId?: string }
    | { type: 'forward-to-popup'; key: string }
    | { type: 'submit' }
    | { type: 'open-quick-search' }
    | { type: 'move-quick-search-selection'; direction: string }
    | { type: 'open-highlighted-quick-search-item' }
    | { type: 'close-quick-search' }
    | { type: 'quick-search-page-up' }
    | { type: 'quick-search-page-down' }
    | { type: 'quick-search-context-menu' }
    | { type: 'quick-search-collapse' }
    | { type: 'navigate-input-history'; direction: string }
    | { type: 'hide-all-popups' }
    | { type: 'cancel-request' }
    | { type: 'clear-model-override' }
    | { type: 'hide-window' }
    | { type: 'clear-session' }
    | { type: 'clear-draft' }
    | { type: 'search-keybinding-action'; actionId: SearchKeybindingActionId };

interface HarnessOptions extends Partial<RouterOptions> {
    historyNavigationResult?: SessionInputHistoryNavigationResult;
}

function createRouterHarness(options: HarnessOptions = {}) {
    const { historyNavigationResult = 'ignored', ...overrides } = options;
    const effects: RoutedEffect[] = [];

    /** Records one observable outcome of a key press. */
    function record(effect: RoutedEffect): void {
        effects.push(effect);
    }

    const defaults: RouterOptions = {
        getSearchKeybindings: () => createDefaultSearchKeybindings(),
        getPendingApproval: () => null,
        getActiveSurface: () => 'search-surface',
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
        onPromptApprovalAttention: () => record({ type: 'prompt-approval-attention' }),
        onRejectApproval: (callId) => record({ type: 'reject-approval', callId }),
        onApproveApproval: (callId) => record({ type: 'approve-approval', callId }),
        onForwardToPopup: (key) => record({ type: 'forward-to-popup', key }),
        onSubmit: () => record({ type: 'submit' }),
        onOpenQuickSearch: () => record({ type: 'open-quick-search' }),
        onMoveQuickSearchSelection: (direction) =>
            record({ type: 'move-quick-search-selection', direction }),
        onOpenHighlightedQuickSearchItem: () =>
            record({ type: 'open-highlighted-quick-search-item' }),
        onCloseQuickSearch: () => record({ type: 'close-quick-search' }),
        onQuickSearchPageUp: () => record({ type: 'quick-search-page-up' }),
        onQuickSearchPageDown: () => record({ type: 'quick-search-page-down' }),
        onQuickSearchContextMenu: () => record({ type: 'quick-search-context-menu' }),
        onQuickSearchCollapse: () => record({ type: 'quick-search-collapse' }),
        onNavigateInputHistory: (direction) => {
            // 'ignored' means the page had nothing to recall, so nothing the user can see happens.
            if (historyNavigationResult !== 'ignored') {
                record({ type: 'navigate-input-history', direction });
            }
            return historyNavigationResult;
        },
        onHideAllPopups: () => record({ type: 'hide-all-popups' }),
        onCancelRequest: () => record({ type: 'cancel-request' }),
        onClearModelOverride: () => record({ type: 'clear-model-override' }),
        onHideWindow: () => record({ type: 'hide-window' }),
        onClearSession: () => record({ type: 'clear-session' }),
        onClearDraft: () => record({ type: 'clear-draft' }),
        onSearchKeybindingAction: (actionId) =>
            record({ type: 'search-keybinding-action', actionId }),
        ...overrides,
    };

    const router = createSearchKeyboardRouter(defaults);

    return {
        effects,
        route: (input: Parameters<typeof router.route>[0]) => router.route(input),
        routeCommand: (actionId: SearchKeybindingActionId, shortcut: string) =>
            router.routeCommand(actionId, shortcut),
    };
}

function keybindingsWith(overrides: Partial<SearchKeybindings>): SearchKeybindings {
    return {
        ...createDefaultSearchKeybindings(),
        ...overrides,
    };
}

describe('when the search input has the focus', () => {
    it('user keeps an ordinary key press for the editor instead of letting the page swallow it', () => {
        const harness = createRouterHarness();

        expect(harness.route({ key: 'a' })).toBe(false);
        expect(harness.effects).toEqual([]);
    });

    it('user sends the draft when pressing Enter', () => {
        const harness = createRouterHarness({ getQueryText: () => 'summarize this' });

        expect(harness.route({ key: 'Enter' })).toBe(true);
        expect(harness.effects).toEqual([{ type: 'submit' }]);
    });

    it('user sends attached files when pressing Enter without any text', () => {
        const harness = createRouterHarness({ hasAttachments: () => true });

        expect(harness.route({ key: 'Enter' })).toBe(true);
        expect(harness.effects).toEqual([{ type: 'submit' }]);
    });

    it('user gets no submission when pressing Enter on an empty input', () => {
        const harness = createRouterHarness();

        expect(harness.route({ key: 'Enter' })).toBe(true);
        expect(harness.effects).toEqual([]);
    });

    it('user starts a new line instead of sending when pressing Shift+Enter', () => {
        const harness = createRouterHarness({ getQueryText: () => 'line one' });

        expect(harness.route({ key: 'Enter', shiftKey: true })).toBe(false);
        expect(harness.effects).toEqual([]);
    });
});

describe('when the user browses previously sent prompts with the arrow keys', () => {
    it('user walks back to the previous prompt with ArrowUp', () => {
        const harness = createRouterHarness({
            getQueryText: () => 'current draft',
            historyNavigationResult: 'navigated',
        });

        expect(harness.route({ key: 'ArrowUp' })).toBe(true);
        expect(harness.effects).toEqual([{ type: 'navigate-input-history', direction: 'older' }]);
    });

    it('user keeps the keypress inside a multiline draft that has text before the caret', () => {
        const harness = createRouterHarness({
            isMultiLineCursor: () => true,
            isCursorAtTextStart: () => false,
            historyNavigationResult: 'navigated',
        });

        expect(harness.route({ key: 'ArrowUp' })).toBe(false);
        expect(harness.effects).toEqual([]);
    });

    it('user keeps the keypress for editing when there is no older prompt to recall', () => {
        const harness = createRouterHarness({ historyNavigationResult: 'ignored' });

        expect(harness.route({ key: 'ArrowUp' })).toBe(false);
        expect(harness.effects).toEqual([]);
    });

    it('user returns to the newer prompt with ArrowDown before any quick search shortcut runs', () => {
        const harness = createRouterHarness({
            historyNavigationResult: 'navigated',
            shouldTriggerQuickSearch: () => true,
        });

        expect(harness.route({ key: 'ArrowDown' })).toBe(true);
        expect(harness.effects).toEqual([{ type: 'navigate-input-history', direction: 'newer' }]);
    });

    it('user cannot browse history with arrow keys combined with a modifier', () => {
        const harness = createRouterHarness({ historyNavigationResult: 'navigated' });

        expect(harness.route({ key: 'ArrowUp', ctrlKey: true })).toBe(false);
        expect(harness.route({ key: 'ArrowDown', shiftKey: true })).toBe(false);
        expect(harness.effects).toEqual([]);
    });
});

describe('when ArrowDown should reveal the quick search panel', () => {
    it('user opens the panel when the input is empty and the query is eligible', () => {
        const harness = createRouterHarness({ shouldTriggerQuickSearch: () => true });

        expect(harness.route({ key: 'ArrowDown' })).toBe(true);
        expect(harness.effects).toEqual([{ type: 'open-quick-search' }]);
    });

    it('user sends the draft instead of opening the panel when the query has text', () => {
        const harness = createRouterHarness({
            getQueryText: () => 'touch',
            shouldTriggerQuickSearch: () => true,
        });

        expect(harness.route({ key: 'ArrowDown' })).toBe(true);
        expect(harness.effects).toEqual([{ type: 'submit' }]);
    });

    it('user keeps the keypress when the current state does not allow a quick search', () => {
        const harness = createRouterHarness({ shouldTriggerQuickSearch: () => false });

        expect(harness.route({ key: 'ArrowDown' })).toBe(false);
        expect(harness.effects).toEqual([]);
    });
});

describe('when Escape is pressed on the search surface', () => {
    it('user dismisses the most specific state first and only hides the window when nothing is left', () => {
        const loading = createRouterHarness({ isLoading: () => true });
        expect(loading.route({ key: 'Escape' })).toBe(true);
        expect(loading.effects).toEqual([{ type: 'cancel-request' }]);

        const withDraft = createRouterHarness({ getQueryText: () => 'half typed' });
        expect(withDraft.route({ key: 'Escape' })).toBe(true);
        expect(withDraft.effects).toEqual([{ type: 'clear-draft' }]);

        const withModelOverride = createRouterHarness({ hasModelOverride: () => true });
        expect(withModelOverride.route({ key: 'Escape' })).toBe(true);
        expect(withModelOverride.effects).toEqual([{ type: 'clear-model-override' }]);

        const withSession = createRouterHarness({ getSessionHistoryCount: () => 2 });
        expect(withSession.route({ key: 'Escape' })).toBe(true);
        expect(withSession.effects).toEqual([{ type: 'clear-session' }]);

        const idle = createRouterHarness();
        expect(idle.route({ key: 'Esc' })).toBe(true);
        expect(idle.effects).toEqual([{ type: 'hide-window' }]);
    });

    it('user collapses a highlighted quick search result before closing the panel or the window', () => {
        const harness = createRouterHarness({
            isQuickSearchOpen: () => true,
            hasQuickSearchHighlight: () => true,
        });

        expect(harness.route({ key: 'Escape' })).toBe(true);
        expect(harness.effects).toEqual([{ type: 'quick-search-collapse' }]);
    });

    it('user closes the open popup surface instead of the search window', () => {
        const harness = createRouterHarness({ getActiveSurface: () => 'model-dropdown-surface' });

        expect(harness.route({ key: 'Escape' })).toBe(true);
        expect(harness.effects).toEqual([{ type: 'hide-all-popups' }]);
    });
});

describe('when a tool approval is waiting for the user', () => {
    const pendingApproval = {
        callId: 'approval-1',
        keyboardApproveAt: 0,
    };

    it('user rejects the approval by pressing Escape', () => {
        const harness = createRouterHarness({
            getPendingApproval: () => pendingApproval,
            getQueryText: () => 'draft that must survive',
        });

        expect(harness.route({ key: 'Escape' })).toBe(true);
        expect(harness.effects).toEqual([{ type: 'reject-approval', callId: 'approval-1' }]);
    });

    it('user approves with Enter once the keyboard approval deadline has passed', () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const harness = createRouterHarness({
            getPendingApproval: () => ({ callId: 'approval-2', keyboardApproveAt: 9_000 }),
        });

        expect(harness.route({ key: 'Enter' })).toBe(true);
        expect(harness.effects).toEqual([{ type: 'approve-approval', callId: 'approval-2' }]);
    });

    it('user is pulled back to the approval panel while the deadline has not passed', () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const harness = createRouterHarness({
            getPendingApproval: () => ({ callId: 'approval-3', keyboardApproveAt: 11_000 }),
        });

        expect(harness.route({ key: 'Enter' })).toBe(true);
        expect(harness.effects).toEqual([{ type: 'prompt-approval-attention' }]);
    });

    it('user is pulled back to the approval panel instead of editing the draft behind it', () => {
        const harness = createRouterHarness({
            getPendingApproval: () => pendingApproval,
        });

        expect(harness.route({ key: 'x' })).toBe(true);
        expect(harness.route({ key: 'Backspace' })).toBe(true);
        expect(harness.route({ key: 'Delete' })).toBe(true);
        expect(harness.route({ key: 'Enter', shiftKey: true })).toBe(true);

        expect(harness.effects).toEqual([
            { type: 'prompt-approval-attention' },
            { type: 'prompt-approval-attention' },
            { type: 'prompt-approval-attention' },
            { type: 'prompt-approval-attention' },
        ]);
    });

    it('user cannot reach configured shortcuts or host accelerator commands while the approval is pending', () => {
        const harness = createRouterHarness({
            getPendingApproval: () => pendingApproval,
            getSearchKeybindings: () => keybindingsWith({ 'search.history.open': 'Mod+Y' }),
        });

        expect(harness.route({ key: 'y', ctrlKey: true })).toBe(true);
        expect(harness.routeCommand('search.history.open', 'Mod+Y')).toBe(true);

        expect(harness.effects).toEqual([]);
    });
});

describe('when another window owns the focus', () => {
    it('user gets the key press consumed so the search surface never reacts behind the popup', () => {
        const harness = createRouterHarness({ hasActivePopupWindowFocus: () => true });

        expect(harness.route({ key: 'A' })).toBe(true);
        expect(harness.route({ key: 'Enter' })).toBe(true);
        expect(harness.effects).toEqual([]);
    });

    it('user cannot trigger search shortcuts or host accelerator commands from the popup', () => {
        const harness = createRouterHarness({ hasActivePopupWindowFocus: () => true });

        expect(harness.route({ key: 'F11' })).toBe(true);
        expect(harness.route({ key: 'h', ctrlKey: true })).toBe(true);
        expect(harness.routeCommand('search.model.toggle', 'Mod+M')).toBe(true);

        expect(harness.effects).toEqual([]);
    });
});

describe('when the model dropdown surface is open', () => {
    it('user gets the navigation keys forwarded to the dropdown instead of handled in place', () => {
        const harness = createRouterHarness({ getActiveSurface: () => 'model-dropdown-surface' });

        expect(harness.route({ key: 'ArrowDown' })).toBe(true);
        expect(harness.route({ key: 'ArrowUp' })).toBe(true);
        expect(harness.route({ key: 'Enter' })).toBe(true);

        expect(harness.effects).toEqual([
            { type: 'forward-to-popup', key: 'ArrowDown' },
            { type: 'forward-to-popup', key: 'ArrowUp' },
            { type: 'forward-to-popup', key: 'Enter' },
        ]);
    });
});

describe('when the quick search panel is open', () => {
    it('user pages through the results with PageUp and PageDown', () => {
        const harness = createRouterHarness({ isQuickSearchOpen: () => true });

        expect(harness.route({ key: 'PageUp' })).toBe(true);
        expect(harness.route({ key: 'PageDown' })).toBe(true);

        expect(harness.effects).toEqual([
            { type: 'quick-search-page-up' },
            { type: 'quick-search-page-down' },
        ]);
    });

    it('user opens the item context menu with the menu key or Shift+F10', () => {
        const harness = createRouterHarness({ isQuickSearchOpen: () => true });

        expect(harness.route({ key: 'ContextMenu' })).toBe(true);
        expect(harness.route({ key: 'F10', shiftKey: true })).toBe(true);

        expect(harness.effects).toEqual([
            { type: 'quick-search-context-menu' },
            { type: 'quick-search-context-menu' },
        ]);
    });

    it('user moves the highlight with every arrow key and opens the highlighted result with Enter', () => {
        const harness = createRouterHarness({
            isQuickSearchOpen: () => true,
            hasQuickSearchHighlight: () => true,
        });

        for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter']) {
            expect(harness.route({ key })).toBe(true);
        }

        expect(harness.effects).toEqual([
            { type: 'move-quick-search-selection', direction: 'up' },
            { type: 'move-quick-search-selection', direction: 'down' },
            { type: 'move-quick-search-selection', direction: 'left' },
            { type: 'move-quick-search-selection', direction: 'right' },
            { type: 'open-highlighted-quick-search-item' },
        ]);
    });

    it('user closes the panel and sends the query with Enter while nothing is highlighted', () => {
        const harness = createRouterHarness({
            getQueryText: () => 'touch',
            isQuickSearchOpen: () => true,
        });

        expect(harness.route({ key: 'Enter' })).toBe(true);
        expect(harness.effects).toEqual([{ type: 'close-quick-search' }, { type: 'submit' }]);
    });

    it('user only closes the panel on Enter when the query is blank', () => {
        const harness = createRouterHarness({
            getQueryText: () => '   ',
            isQuickSearchOpen: () => true,
        });

        expect(harness.route({ key: 'Enter' })).toBe(true);
        expect(harness.effects).toEqual([{ type: 'close-quick-search' }]);
    });

    it('user moves the highlight down when the panel has no highlight yet', () => {
        const harness = createRouterHarness({ isQuickSearchOpen: () => true });

        expect(harness.route({ key: 'ArrowDown' })).toBe(true);
        expect(harness.effects).toEqual([
            { type: 'move-quick-search-selection', direction: 'down' },
        ]);
    });
});

describe('when search shortcuts are configured', () => {
    it('user triggers the action that owns the pressed shortcut', () => {
        const harness = createRouterHarness({
            getSearchKeybindings: () => keybindingsWith({ 'search.history.open': 'Mod+Y' }),
        });

        expect(harness.route({ key: 'y', ctrlKey: true })).toBe(true);
        expect(harness.effects).toEqual([
            { type: 'search-keybinding-action', actionId: 'search.history.open' },
        ]);
    });

    it('user triggers the default shortcuts for maximizing, opening settings and reopening a session', () => {
        const harness = createRouterHarness();

        expect(harness.route({ key: 'F11' })).toBe(true);
        expect(harness.route({ key: ',', ctrlKey: true })).toBe(true);
        expect(harness.route({ key: 't', ctrlKey: true, shiftKey: true })).toBe(true);

        expect(harness.effects).toEqual([
            { type: 'search-keybinding-action', actionId: 'search.window.maximize' },
            { type: 'search-keybinding-action', actionId: 'search.settings.open' },
            { type: 'search-keybinding-action', actionId: 'search.session.reopenLastClosed' },
        ]);
    });

    it('user triggers a function-row shortcut even when the key value is remapped by the keyboard layout', () => {
        const harness = createRouterHarness({
            getSearchKeybindings: () => keybindingsWith({ 'search.history.open': 'F2' }),
        });

        expect(harness.route({ key: 'BrightnessUp', code: 'F2' })).toBe(true);
        expect(harness.effects).toEqual([
            { type: 'search-keybinding-action', actionId: 'search.history.open' },
        ]);
    });

    it('user cannot trigger a shortcut that was disabled in the settings', () => {
        const harness = createRouterHarness({
            getSearchKeybindings: () => keybindingsWith({ 'search.model.toggle': null }),
        });

        expect(harness.route({ key: 'm', ctrlKey: true })).toBe(false);
        expect(harness.effects).toEqual([]);
    });

    it('user triggers whichever action currently owns a shortcut that was moved to it', () => {
        const harness = createRouterHarness({
            getSearchKeybindings: () =>
                keybindingsWith({
                    'search.model.toggle': null,
                    'search.history.open': 'Mod+M',
                    'search.window.maximize': 'F12',
                }),
        });

        expect(harness.route({ key: 'm', ctrlKey: true })).toBe(true);
        expect(harness.route({ key: 'F11' })).toBe(false);
        expect(harness.route({ key: 'F12' })).toBe(true);

        expect(harness.effects).toEqual([
            { type: 'search-keybinding-action', actionId: 'search.history.open' },
            { type: 'search-keybinding-action', actionId: 'search.window.maximize' },
        ]);
    });

    it('user cannot trigger shortcuts that no longer have a default binding', () => {
        const harness = createRouterHarness({
            getQueryText: () => 'touchai',
            isLoading: () => true,
        });

        expect(harness.route({ key: 'Backspace', ctrlKey: true })).toBe(false);
        expect(harness.route({ key: '.', ctrlKey: true })).toBe(false);
        expect(harness.route({ key: '.', ctrlKey: true, shiftKey: true })).toBe(false);
        expect(harness.effects).toEqual([]);
    });

    it('user can only toggle the quick search view while the panel is open', () => {
        const openPanel = createRouterHarness({ isQuickSearchOpen: () => true });
        expect(openPanel.route({ key: 'g', ctrlKey: true })).toBe(true);
        expect(openPanel.effects).toEqual([
            { type: 'search-keybinding-action', actionId: 'search.quickSearch.toggleView' },
        ]);

        const closedPanel = createRouterHarness({ isQuickSearchOpen: () => false });
        expect(closedPanel.route({ key: 'g', ctrlKey: true })).toBe(false);
        expect(closedPanel.effects).toEqual([]);
    });
});

describe('when a shortcut is forwarded from the host window', () => {
    it('user gets the action triggered only while the action still owns that shortcut', () => {
        const harness = createRouterHarness({
            getSearchKeybindings: () =>
                keybindingsWith({
                    'search.model.toggle': null,
                    'search.history.open': 'Mod+M',
                }),
        });

        expect(harness.routeCommand('search.model.toggle', 'Mod+M')).toBe(false);
        expect(harness.routeCommand('search.history.open', 'Mod+M')).toBe(true);

        expect(harness.effects).toEqual([
            { type: 'search-keybinding-action', actionId: 'search.history.open' },
        ]);
    });

    it('user gets the command ignored while the shortcut was remapped to a different key', () => {
        const harness = createRouterHarness({
            getSearchKeybindings: () => keybindingsWith({ 'search.model.toggle': 'Mod+J' }),
        });

        expect(harness.routeCommand('search.model.toggle', 'Mod+M')).toBe(false);
        expect(harness.routeCommand('search.model.toggle', 'Mod+J')).toBe(true);

        expect(harness.effects).toEqual([
            { type: 'search-keybinding-action', actionId: 'search.model.toggle' },
        ]);
    });
});

describe('when a routed action fails', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it('user can keep typing shortcuts after one of them failed in the background', async () => {
        const rejection = new Error('shortcut side effect failed');
        const harness = createRouterHarness({
            onSearchKeybindingAction: (actionId) => {
                harness.effects.push({ type: 'search-keybinding-action', actionId });
                return Promise.reject(rejection);
            },
        });

        expect(harness.route({ key: 'h', ctrlKey: true })).toBe(true);
        await Promise.resolve();
        await Promise.resolve();

        expect(harness.route({ key: 'm', ctrlKey: true })).toBe(true);
        expect(harness.effects).toEqual([
            { type: 'search-keybinding-action', actionId: 'search.history.open' },
            { type: 'search-keybinding-action', actionId: 'search.model.toggle' },
        ]);
    });
});
