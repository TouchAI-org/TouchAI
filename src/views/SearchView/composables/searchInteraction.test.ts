import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '@/types/session';

import {
    createSearchEditorExtensions,
    isCursorAtDocEnd,
} from '../components/SearchBar/utils/tiptap';
import {
    createSearchKeyboardRouter,
    createSessionInputHistoryBrowseState,
    extractSessionInputHistoryEntries,
    navigateSessionInputHistory,
} from './searchInteraction';

function createUserMessage(id: string, content: string): SessionMessage {
    return {
        id,
        role: 'user',
        content,
        parts: [],
        timestamp: Date.now(),
    };
}

function createAssistantMessage(id: string, content: string): SessionMessage {
    return {
        id,
        role: 'assistant',
        content,
        parts: [],
        timestamp: Date.now(),
    };
}

describe('extractSessionInputHistoryEntries', () => {
    it('only keeps user messages in order and supports exclusions', () => {
        const messages: SessionMessage[] = [
            createUserMessage('user-1', 'first prompt'),
            createAssistantMessage('assistant-1', 'assistant reply'),
            createUserMessage('user-2', 'second prompt'),
        ];

        expect(extractSessionInputHistoryEntries(messages)).toEqual([
            'first prompt',
            'second prompt',
        ]);

        expect(
            extractSessionInputHistoryEntries(messages, {
                excludedMessageIds: new Set(['user-2']),
            })
        ).toEqual(['first prompt']);
    });
});

describe('navigateSessionInputHistory', () => {
    it('moves backward through older entries and restores the draft when returning to tail', () => {
        const entries = ['first', 'second', 'third'];
        const initialState = createSessionInputHistoryBrowseState(entries.length);

        const firstBack = navigateSessionInputHistory({
            entries,
            currentQuery: 'draft prompt',
            direction: 'older',
            state: initialState,
        });
        expect(firstBack.changed).toBe(true);
        expect(firstBack.nextQuery).toBe('third');
        expect(firstBack.state.pointer).toBe(2);
        expect(firstBack.state.draftBeforeBrowse).toBe('draft prompt');

        const secondBack = navigateSessionInputHistory({
            entries,
            currentQuery: firstBack.nextQuery,
            direction: 'older',
            state: firstBack.state,
        });
        expect(secondBack.nextQuery).toBe('second');
        expect(secondBack.state.pointer).toBe(1);

        const moveForward = navigateSessionInputHistory({
            entries,
            currentQuery: secondBack.nextQuery,
            direction: 'newer',
            state: secondBack.state,
        });
        expect(moveForward.nextQuery).toBe('third');
        expect(moveForward.state.pointer).toBe(2);

        const restoreDraft = navigateSessionInputHistory({
            entries,
            currentQuery: moveForward.nextQuery,
            direction: 'newer',
            state: moveForward.state,
        });
        expect(restoreDraft.nextQuery).toBe('draft prompt');
        expect(restoreDraft.state.pointer).toBe(entries.length);
    });

    it('returns unchanged when navigation is not possible', () => {
        const noEntries = navigateSessionInputHistory({
            entries: [],
            currentQuery: 'draft',
            direction: 'older',
            state: createSessionInputHistoryBrowseState(),
        });
        expect(noEntries.changed).toBe(false);
        expect(noEntries.nextQuery).toBe('draft');

        const atOldest = navigateSessionInputHistory({
            entries: ['only'],
            currentQuery: 'only',
            direction: 'older',
            state: {
                pointer: 0,
                draftBeforeBrowse: 'draft',
            },
        });
        expect(atOldest.changed).toBe(false);
    });
});

describe('isCursorAtDocEnd', () => {
    it('recognizes the true document end position for multiline editor content', () => {
        const editor = new Editor({
            extensions: createSearchEditorExtensions({}),
            content: {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'first line' }],
                    },
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'second line' }],
                    },
                ],
            },
        });

        try {
            const endSelection = TextSelection.atEnd(editor.state.doc);
            editor.commands.command(({ tr }) => {
                tr.setSelection(endSelection);
                return true;
            });

            expect(isCursorAtDocEnd(editor)).toBe(true);
        } finally {
            editor.destroy();
        }
    });
});

describe('createSearchKeyboardRouter', () => {
    function createRouter(
        overrides: Partial<Parameters<typeof createSearchKeyboardRouter>[0]> = {}
    ) {
        const onNavigateInputHistory = overrides.onNavigateInputHistory ?? vi.fn(() => false);
        const onOpenQuickSearch = overrides.onOpenQuickSearch ?? vi.fn();
        const onSubmit = overrides.onSubmit ?? vi.fn();

        const router = createSearchKeyboardRouter({
            getPendingApproval: () => null,
            getActiveSurface: () => 'search-surface',
            hasActivePopupWindowFocus: () => false,
            getQueryText: () => 'query',
            isQuickSearchOpen: () => false,
            hasQuickSearchHighlight: () => false,
            shouldTriggerQuickSearch: () => true,
            isMultiLineCursor: () => false,
            isCursorAtStart: () => true,
            isCursorAtEnd: () => true,
            hasModelOverride: () => false,
            getSessionHistoryCount: () => 0,
            isLoading: () => false,
            onPromptApprovalAttention: vi.fn(),
            onRejectApproval: vi.fn(),
            onApproveApproval: vi.fn(),
            onForwardToPopup: vi.fn(),
            onSubmit,
            onOpenQuickSearch,
            onMoveQuickSearchSelection: vi.fn(),
            onOpenHighlightedQuickSearchItem: vi.fn(),
            onCloseQuickSearch: vi.fn(),
            onNavigateInputHistory,
            onHideAllPopups: vi.fn(),
            onCancelRequest: vi.fn(),
            onClearModelOverride: vi.fn(),
            onHideWindow: vi.fn(),
            onClearSession: vi.fn(),
            onClearAll: vi.fn(),
            onPrimaryShortcut: vi.fn(),
            ...overrides,
        });

        return { router, onNavigateInputHistory, onOpenQuickSearch, onSubmit };
    }

    it('uses ArrowUp to navigate input history instead of submitting', () => {
        const { router, onNavigateInputHistory, onSubmit } = createRouter({
            onNavigateInputHistory: vi.fn((direction) => direction === 'older'),
        });

        expect(router.route({ key: 'ArrowUp' })).toBe(true);
        expect(onNavigateInputHistory).toHaveBeenCalledWith('older');
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('only uses ArrowUp on multiline input when the cursor is at the start', () => {
        const navigate = vi.fn(() => true);
        const { router } = createRouter({
            isMultiLineCursor: () => true,
            isCursorAtStart: () => false,
            onNavigateInputHistory: navigate,
        });

        expect(router.route({ key: 'ArrowUp' })).toBe(false);
        expect(navigate).not.toHaveBeenCalled();
    });

    it('uses ArrowDown to navigate newer history before falling back to QuickSearch', () => {
        const navigate = vi.fn(() => true);
        const { router, onOpenQuickSearch } = createRouter({
            onNavigateInputHistory: navigate,
        });

        expect(router.route({ key: 'ArrowDown' })).toBe(true);
        expect(navigate).toHaveBeenCalledWith('newer');
        expect(onOpenQuickSearch).not.toHaveBeenCalled();
    });

    it('only uses ArrowDown on multiline input when the cursor is at the end', () => {
        const navigate = vi.fn(() => true);
        const { router, onOpenQuickSearch } = createRouter({
            isMultiLineCursor: () => true,
            isCursorAtEnd: () => false,
            onNavigateInputHistory: navigate,
        });

        expect(router.route({ key: 'ArrowDown' })).toBe(false);
        expect(navigate).not.toHaveBeenCalled();
        expect(onOpenQuickSearch).not.toHaveBeenCalled();
    });

    it('falls back to QuickSearch on ArrowDown when there is no newer history entry', () => {
        const navigate = vi.fn(() => false);
        const { router, onOpenQuickSearch } = createRouter({
            onNavigateInputHistory: navigate,
        });

        expect(router.route({ key: 'ArrowDown' })).toBe(true);
        expect(navigate).toHaveBeenCalledWith('newer');
        expect(onOpenQuickSearch).toHaveBeenCalledTimes(1);
    });
});
