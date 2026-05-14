import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';

import {
    createSearchEditorExtensions,
    isCursorAtTextStart,
} from '../components/SearchBar/utils/tiptap';
import { createSearchKeyboardRouter } from './searchInteraction';

describe('isCursorAtTextStart', () => {
    it('treats the position after the model tag as the text start boundary', () => {
        const editor = new Editor({
            extensions: createSearchEditorExtensions({}),
            content: {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            {
                                type: 'modelTag',
                                attrs: {
                                    modelId: 'gpt-4o',
                                    modelName: 'GPT-4o',
                                    providerId: 1,
                                },
                            },
                            {
                                type: 'text',
                                text: 'hello',
                            },
                        ],
                    },
                ],
            },
        });

        try {
            let modelTagPos = 0;
            let modelTagSize = 0;

            editor.state.doc.descendants((node, pos) => {
                if (node.type.name !== 'modelTag') {
                    return true;
                }

                modelTagPos = pos;
                modelTagSize = node.nodeSize;
                return false;
            });

            editor.commands.command(({ tr }) => {
                tr.setSelection(TextSelection.create(tr.doc, modelTagPos + modelTagSize));
                return true;
            });

            expect(isCursorAtTextStart(editor)).toBe(true);
        } finally {
            editor.destroy();
        }
    });
});

describe('createSearchKeyboardRouter', () => {
    it('navigates older history from multiline input when the cursor is at text start', () => {
        const onNavigateInputHistory = vi.fn((direction) => direction === 'older');
        const router = createSearchKeyboardRouter({
            getPendingApproval: () => null,
            getActiveSurface: () => 'search-surface',
            hasActivePopupWindowFocus: () => false,
            getQueryText: () => 'query',
            isQuickSearchOpen: () => false,
            hasQuickSearchHighlight: () => false,
            shouldTriggerQuickSearch: () => false,
            isMultiLineCursor: () => true,
            isCursorAtStart: () => false,
            isCursorAtTextStart: () => true,
            isCursorAtEnd: () => false,
            hasModelOverride: () => false,
            getSessionHistoryCount: () => 1,
            isLoading: () => false,
            onPromptApprovalAttention: vi.fn(),
            onRejectApproval: vi.fn(),
            onApproveApproval: vi.fn(),
            onForwardToPopup: vi.fn(),
            onSubmit: vi.fn(),
            onOpenQuickSearch: vi.fn(),
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
        });

        expect(router.route({ key: 'ArrowUp' })).toBe(true);
        expect(onNavigateInputHistory).toHaveBeenCalledWith('older');
    });
});
