import { mountComposable } from '@tests/utils/composables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import {
    createDefaultSearchKeybindings,
    SEARCH_KEYBINDING_DEFINITIONS,
} from '@/config/searchKeybindings';
import { createInputHistorySnapshot, type SessionMessage } from '@/types/session';
import {
    createSearchEntryPolicy,
    createSearchKeyboardRouter,
    createSessionInputHistoryBrowseState,
    extractSessionInputHistoryEntries,
    navigateSessionInputHistory,
    useQuickSearchCoordinator,
} from '@/views/SearchView/composables/searchInteraction';
import { filterModelDropdownItems } from '@/views/SearchView/composables/useSearchPage';
import type {
    SearchCursorContext,
    SearchModelOverride,
    SearchPageController,
} from '@/views/SearchView/types';

function createUserMessage(id: string, overrides: Partial<SessionMessage> = {}): SessionMessage {
    return {
        id,
        role: 'user',
        content: '',
        parts: [],
        timestamp: Number(id),
        ...overrides,
    };
}

function createControllerStub() {
    return {
        focusConversation: vi.fn(),
        focusSearchInput: vi.fn().mockResolvedValue(undefined),
        loadActiveModel: vi.fn().mockResolvedValue(undefined),
        prefetchModelDropdownData: vi.fn().mockResolvedValue(undefined),
        invalidateModelDropdownData: vi.fn(),
        prepareModelDropdownOpen: vi.fn().mockResolvedValue(undefined),
        selectModelFromDropdown: vi.fn().mockResolvedValue({ modelId: null, providerId: null }),
        getModelDropdownAnchor: vi.fn(() => null),
        getModelDropdownContext: vi.fn(() => ({
            activeModelId: null,
            activeProviderId: null,
            selectedModelId: null,
            selectedProviderId: null,
            models: [],
        })),
        isQuickSearchOpen: vi.fn(() => false),
        isQuickSearchItemHighlighted: vi.fn(() => false),
        openQuickSearch: vi.fn(),
        closeQuickSearch: vi.fn(),
        settleQuickSearchInteraction: vi.fn(),
        moveQuickSearchSelection: vi.fn(),
        openHighlightedQuickSearchItem: vi.fn().mockResolvedValue(undefined),
        triggerQuickSearch: vi.fn(),
        goToPageQuickSearch: vi.fn(),
        goToNextPageQuickSearch: vi.fn(),
        goToPreviousPageQuickSearch: vi.fn(),
        openQuickSearchContextMenu: vi.fn(),
        toggleQuickSearchView: vi.fn(),
        collapseQuickSearch: vi.fn(),
        isQuickSearchContextMenuOpen: vi.fn(() => false),
        closeQuickSearchContextMenu: vi.fn(),
    } satisfies SearchPageController;
}

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('when the user filters the model list', () => {
    const models = [
        {
            id: 1,
            modelId: 'claude-sonnet',
            name: 'Claude Sonnet',
            providerId: 1,
            providerName: 'Anthropic',
            reasoning: 0,
            tool_call: 0,
            modalities: null,
            attachment: 0,
            open_weights: 0,
        },
        {
            id: 2,
            modelId: 'codex-mini',
            name: 'Codex Mini',
            providerId: 2,
            providerName: 'OpenAI',
            reasoning: 0,
            tool_call: 0,
            modalities: null,
            attachment: 0,
            open_weights: 0,
        },
        {
            id: 3,
            modelId: 'gpt-5',
            name: 'GPT 5',
            providerId: 2,
            providerName: 'OpenAI',
            reasoning: 0,
            tool_call: 0,
            modalities: null,
            attachment: 0,
            open_weights: 0,
        },
    ];

    it.each([
        ['', [1, 2, 3]],
        ['  ', [1, 2, 3]],
        ['SONNET', [1]],
        ['gpt-5', [3]],
        ['openai', [2, 3]],
        ['cdx', [2]],
        ['openai mini', [2]],
        ['gemini', []],
    ])('user sees the matching models for query %j', (query, ids) => {
        expect(filterModelDropdownItems(models, query).map((model) => model.id)).toEqual(ids);
    });

    it('user sees a direct match before a fuzzy match listed earlier', () => {
        const candidates = [
            { ...models[0]!, name: 'Great Prompt Thing 4', modelId: 'great-prompt-thing-4' },
            { ...models[1]!, name: 'GPT-4o mini', modelId: 'gpt4o-mini' },
        ];
        expect(filterModelDropdownItems(candidates, 'gpt4').map((model) => model.id)).toEqual([
            2, 1,
        ]);
    });
});

describe('extractSessionInputHistoryEntries', () => {
    it('returns only user prompts that still have visible input history content', () => {
        const entries = extractSessionInputHistoryEntries([
            createUserMessage('1', {
                content: 'fallback text',
            }),
            createUserMessage('2', {
                inputSnapshot: createInputHistorySnapshot({
                    text: '',
                    attachments: [],
                    excludeFromHistory: true,
                }),
            }),
            {
                id: '3',
                role: 'assistant',
                content: 'assistant reply',
                parts: [],
                timestamp: 3,
            },
            createUserMessage('4', {
                inputSnapshot: createInputHistorySnapshot({
                    text: '',
                    attachments: [
                        {
                            id: 'attachment-1',
                            type: 'file',
                            path: 'D:/file.txt',
                            originPath: 'D:/file.txt',
                            name: 'file.txt',
                        },
                    ],
                }),
            }),
        ]);

        expect(entries).toEqual([
            createInputHistorySnapshot({
                text: 'fallback text',
                attachments: [],
            }),
            createInputHistorySnapshot({
                text: '',
                attachments: [
                    {
                        id: 'attachment-1',
                        type: 'file',
                        path: 'D:/file.txt',
                        originPath: 'D:/file.txt',
                        name: 'file.txt',
                    },
                ],
            }),
        ]);
    });
});

describe('navigateSessionInputHistory', () => {
    it('captures the current draft when browsing older history from the latest position', () => {
        const latestDraft = createInputHistorySnapshot({
            text: 'draft',
            attachments: [],
        });
        const entries = [
            createInputHistorySnapshot({ text: 'first', attachments: [] }),
            createInputHistorySnapshot({ text: 'second', attachments: [] }),
        ];

        const result = navigateSessionInputHistory({
            entries,
            currentDraft: latestDraft,
            direction: 'older',
            state: createSessionInputHistoryBrowseState(entries.length),
        });

        expect(result.changed).toBe(true);
        expect(result.nextSnapshot).toEqual(entries[1]);
        expect(result.state).toEqual({
            pointer: 1,
            draftBeforeBrowse: latestDraft,
            activeBrowseSnapshot: entries[1],
        });
    });

    it('user gets their draft back when stepping forward to the newest position', () => {
        const restoredDraft = createInputHistorySnapshot({
            text: 'draft before browse',
            attachments: [],
        });
        const firstEntry = createInputHistorySnapshot({ text: 'first', attachments: [] });
        const secondEntry = createInputHistorySnapshot({ text: 'second', attachments: [] });
        const entries = [firstEntry, secondEntry];

        const result = navigateSessionInputHistory({
            entries,
            currentDraft: createInputHistorySnapshot({ text: 'ignored', attachments: [] }),
            direction: 'newer',
            state: {
                pointer: 1,
                draftBeforeBrowse: restoredDraft,
                activeBrowseSnapshot: secondEntry,
            },
        });

        expect(result.changed).toBe(true);
        expect(result.nextSnapshot).toEqual(restoredDraft);
        expect(result.state).toEqual({
            pointer: 2,
            draftBeforeBrowse: restoredDraft,
            activeBrowseSnapshot: null,
        });
    });
});

describe('createSearchEntryPolicy', () => {
    it('user gets the entry checked once per appearance and each snapshot consumed once', () => {
        const policy = createSearchEntryPolicy();

        expect(
            policy.shouldCheckShortcutEntry({
                activationSource: 'shortcut',
                visibilityEpoch: 3,
                entryCheckArmedVisibilityEpoch: 3,
                lastEntryCheckedVisibilityEpoch: null,
            })
        ).toBe(true);

        expect(policy.shouldConsumeSnapshot('snapshot-1')).toBe(true);
        policy.markSnapshotConsumed('snapshot-1');
        expect(policy.shouldConsumeSnapshot('snapshot-1')).toBe(false);
        expect(
            policy.shouldCheckShortcutEntry({
                activationSource: 'shortcut',
                visibilityEpoch: 3,
                entryCheckArmedVisibilityEpoch: 3,
                lastEntryCheckedVisibilityEpoch: 3,
            })
        ).toBe(false);
    });
});

describe('useQuickSearchCoordinator', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('opens quick search only when the query satisfies the coordinator policy', async () => {
        const controller = createControllerStub();
        const queryText = ref('touchai');
        const attachments = ref<unknown[]>([]);
        const sessionHistory = ref<SessionMessage[]>([]);
        const cursorContext = ref<SearchCursorContext>({
            isMultiLine: false,
            cursorAtStart: true,
            cursorAtTextStart: true,
            cursorAtEnd: true,
        });
        const modelOverride = ref<SearchModelOverride>({
            modelId: null,
            providerId: null,
        });
        const modelDropdownState = ref({ isOpen: false });
        const activeOverlay = ref<'none' | 'model-dropdown' | 'session-history'>('none');
        const quickSearchOpen = ref(false);

        const mounted = await mountComposable(() =>
            useQuickSearchCoordinator({
                queryText,
                attachments,
                sessionHistory,
                cursorContext,
                modelOverride,
                modelDropdownState,
                activeOverlay,
                quickSearchOpen,
                controller,
            })
        );

        mounted.result.syncQuickSearchPanel();

        expect(controller.triggerQuickSearch).toHaveBeenCalledWith('touchai');

        attachments.value = [{ id: 'attachment-blocker' }];
        await nextTick();

        expect(controller.closeQuickSearch).toHaveBeenCalled();

        mounted.unmount();
    });

    it('treats model selection and session history as authoritative quick-search blockers', async () => {
        const controller = createControllerStub();
        const queryText = ref('touchai');
        const sessionHistory = ref<SessionMessage[]>([]);
        const modelOverride = ref<SearchModelOverride>({ modelId: null, providerId: null });
        const activeOverlay = ref<'none' | 'model-dropdown' | 'session-history'>('none');

        const mounted = await mountComposable(() =>
            useQuickSearchCoordinator({
                queryText,
                attachments: ref([]),
                sessionHistory,
                cursorContext: ref({
                    isMultiLine: false,
                    cursorAtStart: true,
                    cursorAtTextStart: true,
                    cursorAtEnd: true,
                }),
                modelOverride,
                modelDropdownState: ref({ isOpen: false }),
                activeOverlay,
                quickSearchOpen: ref(true),
                controller,
            })
        );

        modelOverride.value = { modelId: 'gpt-5', providerId: 2 };
        await nextTick();
        expect(controller.closeQuickSearch).toHaveBeenCalled();

        controller.closeQuickSearch.mockClear();
        modelOverride.value = { modelId: null, providerId: null };
        sessionHistory.value = [createUserMessage('9', { content: 'existing prompt' })];
        await nextTick();
        expect(controller.closeQuickSearch).toHaveBeenCalled();

        controller.closeQuickSearch.mockClear();
        sessionHistory.value = [];
        activeOverlay.value = 'session-history';
        await nextTick();
        // A popup blocks auto-opening; it must not dismiss a list that is already showing results.
        expect(controller.closeQuickSearch).not.toHaveBeenCalled();
        expect(mounted.result.shouldTriggerQuickSearch('touchai')).toBe(false);

        mounted.unmount();
    });
});

describe('createSearchKeyboardRouter', () => {
    function createKeyboardRouter(
        overrides: Partial<Parameters<typeof createSearchKeyboardRouter>[0]> = {}
    ) {
        const callbacks = {
            onPromptApprovalAttention: vi.fn(),
            onRejectApproval: vi.fn(),
            onApproveApproval: vi.fn(),
            onForwardToOverlay: vi.fn(),
            onSubmit: vi.fn(),
            onOpenQuickSearch: vi.fn(),
            onMoveQuickSearchSelection: vi.fn(),
            onOpenHighlightedQuickSearchItem: vi.fn(),
            onCloseQuickSearch: vi.fn(),
            onQuickSearchPageUp: vi.fn(),
            onQuickSearchPageDown: vi.fn(),
            onQuickSearchContextMenu: vi.fn(),
            onQuickSearchCollapse: vi.fn(),
            onNavigateInputHistory: vi.fn(() => 'ignored' as const),
            onHideAllOverlays: vi.fn(),
            onCancelRequest: vi.fn(),
            onClearModelOverride: vi.fn(),
            onHideWindow: vi.fn(),
            onClearSession: vi.fn(),
            onClearDraft: vi.fn(),
            onPrimaryShortcut: vi.fn(),
            onSearchKeybindingAction: vi.fn(),
        };

        return {
            callbacks,
            router: createSearchKeyboardRouter({
                getPendingApproval: () => null,
                getSearchKeybindings: () => createDefaultSearchKeybindings(),
                getActiveSurface: () => 'search-surface',
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
                ...callbacks,
                ...overrides,
            }),
        };
    }

    it('rejects pending approval with escape before normal surface handling', () => {
        const { router, callbacks } = createKeyboardRouter({
            getPendingApproval: () => ({
                callId: 'approval-1',
                keyboardApproveAt: Date.now() + 1_000,
            }),
        });

        const handled = router.route({ key: 'Escape' });

        expect(handled).toBe(true);
        expect(callbacks.onRejectApproval).toHaveBeenCalledWith('approval-1');
    });

    it('leaves IME composition keys to the editor instead of submitting or selecting', () => {
        const { router, callbacks } = createKeyboardRouter({
            getQueryText: () => '输入中',
            getActiveSurface: () => 'model-dropdown-surface',
        });

        expect(router.route({ key: 'Enter', isComposing: true })).toBe(false);
        expect(router.route({ key: 'Enter', keyCode: 229 })).toBe(false);
        expect(callbacks.onSubmit).not.toHaveBeenCalled();
        expect(callbacks.onForwardToOverlay).not.toHaveBeenCalled();
    });

    it('submits when ArrowDown cannot navigate newer history and query text is present', () => {
        const { router, callbacks } = createKeyboardRouter({
            getQueryText: () => 'touch',
            shouldTriggerQuickSearch: () => true,
            onNavigateInputHistory: vi.fn(() => 'ignored' as const),
        });

        const handled = router.route({ key: 'ArrowDown' });

        expect(handled).toBe(true);
        expect(callbacks.onSubmit).toHaveBeenCalledTimes(1);
        expect(callbacks.onOpenQuickSearch).not.toHaveBeenCalled();
    });

    it('leaves an open quick search panel mounted while submitting', () => {
        const order: string[] = [];
        const onSubmit = vi.fn(() => {
            order.push('submit');
        });
        const onCloseQuickSearch = vi.fn(() => {
            order.push('close');
        });
        const { router } = createKeyboardRouter({
            getQueryText: () => '11',
            isQuickSearchOpen: () => true,
            hasQuickSearchHighlight: () => false,
            onSubmit,
            onCloseQuickSearch,
        });

        expect(router.route({ key: 'Enter' })).toBe(true);
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onCloseQuickSearch).not.toHaveBeenCalled();
        expect(order).toEqual(['submit']);
    });

    it('opens quick search when ArrowDown cannot navigate newer history and query is empty with eligible trigger', () => {
        const { router, callbacks } = createKeyboardRouter({
            getQueryText: () => '',
            shouldTriggerQuickSearch: () => true,
            hasAttachments: () => false,
            onNavigateInputHistory: vi.fn(() => 'ignored' as const),
        });

        const handled = router.route({ key: 'ArrowDown' });

        expect(handled).toBe(true);
        expect(callbacks.onOpenQuickSearch).toHaveBeenCalledTimes(1);
    });

    it('does not navigate input history when multiline cursor is not at the text start', () => {
        const { router, callbacks } = createKeyboardRouter({
            isMultiLineCursor: () => true,
            isCursorAtTextStart: () => false,
        });

        const handled = router.route({ key: 'ArrowUp' });

        expect(handled).toBe(false);
        expect(callbacks.onNavigateInputHistory).not.toHaveBeenCalled();
    });

    it('forwards model-dropdown arrow keys to the overlay surface contract', () => {
        const { router, callbacks } = createKeyboardRouter({
            getActiveSurface: () => 'model-dropdown-surface',
        });

        const handled = router.route({ key: 'ArrowDown' });

        expect(handled).toBe(true);
        expect(callbacks.onForwardToOverlay).toHaveBeenCalledWith('ArrowDown');
    });

    it('clears the draft before model/session/window dismissal on escape', () => {
        const { router, callbacks } = createKeyboardRouter({
            getQueryText: () => 'hello',
        });

        const handled = router.route({ key: 'Escape' });

        expect(handled).toBe(true);
        expect(callbacks.onClearDraft).toHaveBeenCalledTimes(1);
        expect(callbacks.onClearModelOverride).not.toHaveBeenCalled();
        expect(callbacks.onClearSession).not.toHaveBeenCalled();
        expect(callbacks.onHideWindow).not.toHaveBeenCalled();
    });

    it('routes direct Quick Search navigation and toggle keys without history fallback', () => {
        const { router, callbacks } = createKeyboardRouter({
            isQuickSearchOpen: () => true,
            hasQuickSearchHighlight: () => true,
        });

        expect(router.route({ key: 'ArrowRight' })).toBe(true);
        expect(callbacks.onMoveQuickSearchSelection).toHaveBeenCalledWith('right');
        expect(router.route({ key: 'g', ctrlKey: true })).toBe(true);
        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledWith(
            'search.quickSearch.toggleView'
        );
        expect(callbacks.onNavigateInputHistory).not.toHaveBeenCalled();
    });

    it('collapses highlighted Quick Search on escape before clearing authoritative state', () => {
        const { router, callbacks } = createKeyboardRouter({
            getQueryText: () => 'touchai',
            isQuickSearchOpen: () => true,
            hasQuickSearchHighlight: () => true,
            hasModelOverride: () => true,
            getSessionHistoryCount: () => 1,
        });

        expect(router.route({ key: 'Escape' })).toBe(true);
        expect(callbacks.onQuickSearchCollapse).toHaveBeenCalledTimes(1);
        expect(callbacks.onClearDraft).not.toHaveBeenCalled();
        expect(callbacks.onClearModelOverride).not.toHaveBeenCalled();
        expect(callbacks.onClearSession).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        'user keeps Shift+Enter editing when the key repeat flag is %s',
        (repeat) => {
            const { router, callbacks } = createKeyboardRouter({
                isQuickSearchOpen: () => true,
                hasQuickSearchHighlight: () => true,
            });
            expect(router.route({ key: 'Enter', shiftKey: true, repeat })).toBe(false);
            expect(callbacks.onSubmit).not.toHaveBeenCalled();
            expect(callbacks.onOpenHighlightedQuickSearchItem).not.toHaveBeenCalled();
        }
    );

    it('routes configured Ctrl+M and Ctrl+H actions', async () => {
        const { router, callbacks } = createKeyboardRouter();

        expect(router.route({ key: 'm', ctrlKey: true })).toBe(true);
        expect(router.route({ key: 'h', ctrlKey: true })).toBe(true);
        await flushMicrotasks();

        expect(callbacks.onSearchKeybindingAction).toHaveBeenNthCalledWith(
            1,
            'search.model.toggle'
        );
        expect(callbacks.onSearchKeybindingAction).toHaveBeenNthCalledWith(
            2,
            'search.history.open'
        );
        expect(callbacks.onPrimaryShortcut).not.toHaveBeenCalled();
    });

    it.each(SEARCH_KEYBINDING_DEFINITIONS)(
        'user invokes $id once per press through both shortcut paths',
        ({ id, defaultShortcut }) => {
            const { router, callbacks } = createKeyboardRouter({ isQuickSearchOpen: () => true });
            const tokens = defaultShortcut!.split('+');
            const key = tokens[tokens.length - 1]!;
            const input = {
                key: key === 'F11' ? key : key.toLowerCase(),
                ctrlKey: tokens.includes('Mod'),
                shiftKey: tokens.includes('Shift'),
            };
            expect(router.route(input)).toBe(true);
            expect(callbacks.onSearchKeybindingAction).toHaveBeenLastCalledWith(id);
            expect(router.route({ ...input, repeat: true })).toBe(true);
            expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledTimes(1);
            expect(router.routeCommand(id, defaultShortcut!)).toBe(true);
            expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledTimes(2);
            expect(callbacks.onHideWindow).not.toHaveBeenCalled();
        }
    );

    it.each([null, 'Mod+Shift+G'])(
        'user disables the old QuickSearch binding when it is changed to %s',
        (binding) => {
            const bindings = createDefaultSearchKeybindings();
            bindings['search.quickSearch.toggleView'] = binding;
            const { router, callbacks } = createKeyboardRouter({
                getSearchKeybindings: () => bindings,
                isQuickSearchOpen: () => true,
            });
            expect(router.route({ key: 'g', ctrlKey: true })).toBe(false);
            expect(callbacks.onSearchKeybindingAction).not.toHaveBeenCalled();
        }
    );

    it('user cannot bypass a pending approval through a configured DOM shortcut', () => {
        const { router, callbacks } = createKeyboardRouter({
            getPendingApproval: () => ({ callId: 'pending', keyboardApproveAt: 0 }),
        });
        expect(router.route({ key: 'n', ctrlKey: true })).toBe(true);
        expect(router.routeCommand('search.session.new', 'Mod+N')).toBe(true);
        expect(callbacks.onSearchKeybindingAction).not.toHaveBeenCalled();
    });

    it('user holding Escape does not cascade from draft clearing into window dismissal', () => {
        let draft = 'keep session';
        const { router, callbacks } = createKeyboardRouter({
            getQueryText: () => draft,
            onClearDraft: () => {
                draft = '';
            },
        });
        expect(router.route({ key: 'Escape' })).toBe(true);
        expect(router.route({ key: 'Escape', repeat: true })).toBe(true);
        expect(callbacks.onHideWindow).not.toHaveBeenCalled();
    });

    it('rejects a stale accelerator command after the shortcut is rebound', () => {
        const keybindings = createDefaultSearchKeybindings();
        keybindings['search.model.toggle'] = 'Mod+Shift+M';
        const { router, callbacks } = createKeyboardRouter({
            getSearchKeybindings: () => keybindings,
        });

        expect(router.routeCommand('search.model.toggle', 'Mod+M')).toBe(false);
        expect(router.routeCommand('search.model.toggle', 'Mod+Shift+M')).toBe(true);
        expect(callbacks.onSearchKeybindingAction).toHaveBeenCalledWith('search.model.toggle');
    });

    it('closes an active overlay on escape before clearing the draft', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getActiveSurface: () => 'session-history-surface',
            getQueryText: () => 'preserve me',
        });

        expect(router.route({ key: 'Escape' })).toBe(true);
        await flushMicrotasks();

        expect(callbacks.onHideAllOverlays).toHaveBeenCalledTimes(1);
        expect(callbacks.onClearDraft).not.toHaveBeenCalled();
    });

    it.each(['model-dropdown-surface', 'session-history-surface'] as const)(
        'dismisses %s before the highlighted QuickSearch beneath it on escape',
        async (surface) => {
            const { router, callbacks } = createKeyboardRouter({
                getActiveSurface: () => surface,
                isQuickSearchOpen: () => true,
                hasQuickSearchHighlight: () => true,
            });

            expect(router.route({ key: 'Escape' })).toBe(true);
            await flushMicrotasks();

            expect(callbacks.onHideAllOverlays).toHaveBeenCalledOnce();
            expect(callbacks.onQuickSearchCollapse).not.toHaveBeenCalled();
            expect(callbacks.onClearDraft).not.toHaveBeenCalled();
        }
    );

    it('fires the stop-request primary shortcut only while the request is still loading', async () => {
        const { router, callbacks } = createKeyboardRouter({
            getQueryText: () => '',
            isLoading: () => true,
        });

        const handled = router.route({ key: '.', ctrlKey: true });
        await flushMicrotasks();

        expect(handled).toBe(true);
        expect(callbacks.onPrimaryShortcut).toHaveBeenCalledWith('.');
    });
});
