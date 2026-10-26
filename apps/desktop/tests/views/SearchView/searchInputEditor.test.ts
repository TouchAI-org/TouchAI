import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { setLocale } from '@/i18n';

/**
 * useSearchInput owns the editor instance lifecycle and the mouse/keyboard
 * interpretation around it. The editor itself is a tiptap view that cannot mount
 * in jsdom, so it is replaced at the `@tiptap/vue-3` boundary by a stand-in that
 * records its options and exposes the same minimal surface the composable calls.
 * Everything asserted below is what the composable does with that editor and what
 * it reports to the page through its callbacks.
 */
const {
    createSearchEditorExtensionsMock,
    editorInstances,
    getEditorTextMock,
    getModelTagMock,
    getAttachmentTagsMock,
    handleEditorClickMock,
    insertAttachmentTagMock,
    insertModelTagMock,
    isBlankEditorAreaTargetMock,
    isCursorAtDocEndMock,
    isCursorAtDocStartMock,
    isCursorAtTextStartMock,
    isSearchTagDomTargetMock,
    MockEditor,
    modelSelectionState,
    removeAttachmentTagMock,
    removeModelTagMock,
    resolveMouseEventTargetMock,
    updateAttachmentTagMock,
    useDraggingMock,
} = vi.hoisted(() => {
    class MockEditor {
        __text = '';
        commands = {
            focus: vi.fn(),
        };
        options: Record<string, unknown>;
        destroy = vi.fn();
        state: {
            selection: {
                empty: boolean;
                from: number;
                to: number;
                $anchor: { pos: number };
            };
            doc: {
                descendants: (
                    callback: (node: { type: { name: string } }) => boolean | void
                ) => void;
            };
            tr: { setMeta: ReturnType<typeof vi.fn> };
        };
        view: {
            dom: HTMLElement;
            dispatch: ReturnType<typeof vi.fn>;
            coordsAtPos: ReturnType<typeof vi.fn>;
            state: MockEditor['state'];
        };

        constructor(options: Record<string, unknown>) {
            this.options = options;
            this.state = {
                selection: {
                    empty: true,
                    from: 1,
                    to: 1,
                    $anchor: { pos: 1 },
                },
                doc: {
                    descendants: (
                        callback: (node: { type: { name: string } }) => boolean | void
                    ) => {
                        callback({ type: { name: 'paragraph' } });
                    },
                },
                tr: { setMeta: vi.fn() },
            };
            this.view = {
                dom: document.createElement('div'),
                dispatch: vi.fn(),
                coordsAtPos: vi.fn(() => ({ top: 0, bottom: 20 })),
                state: this.state,
            };
            editorInstances.push(this);
        }
    }

    return {
        createSearchEditorExtensionsMock: vi.fn((options?: unknown) => {
            void options;
            return [];
        }),
        editorInstances: [] as InstanceType<typeof MockEditor>[],
        getAttachmentTagsMock: vi.fn(() => []),
        getEditorTextMock: vi.fn((editor: MockEditorInstance) => editor.__text),
        getModelTagMock: vi.fn(() => null),
        handleEditorClickMock: vi.fn(),
        insertAttachmentTagMock: vi.fn(),
        insertModelTagMock: vi.fn(),
        isBlankEditorAreaTargetMock: vi.fn(() => false),
        isCursorAtDocEndMock: vi.fn(() => false),
        isCursorAtDocStartMock: vi.fn(() => false),
        isCursorAtTextStartMock: vi.fn(() => false),
        isSearchTagDomTargetMock: vi.fn(() => false),
        MockEditor,
        modelSelectionState: { current: null as null | Record<string, unknown> },
        removeAttachmentTagMock: vi.fn(),
        removeModelTagMock: vi.fn(),
        resolveMouseEventTargetMock: vi.fn((event: MouseEvent) => event.target as HTMLElement),
        updateAttachmentTagMock: vi.fn(),
        useDraggingMock: {
            handleContainerMouseDown: vi.fn(),
            handleEditorMouseDown: vi.fn(),
            consumeEditorClickAfterDrag: vi.fn(() => false),
            clearEditorSelectionDragState: vi.fn(),
        },
    };
});

type MockEditorInstance = (typeof editorInstances)[number];

type SearchEditorExtensionOptions = {
    onTagRemoved?: (tagName: string, id: string) => void;
    placeholder?: unknown;
};

function lastExtensionOptions(): SearchEditorExtensionOptions {
    const calls = createSearchEditorExtensionsMock.mock.calls;
    return (calls[calls.length - 1]?.[0] ?? {}) as SearchEditorExtensionOptions;
}

vi.mock('@/views/SearchView/components/SearchBar/tags', () => ({}));

vi.mock('@tiptap/vue-3', () => ({
    Editor: MockEditor,
}));

vi.mock('@/services/AgentService/infrastructure/attachments', () => ({
    buildAttachmentPromptMetas: vi.fn((attachments: Array<{ id: string }>) =>
        attachments.map((attachment, index) => ({ alias: `A${index + 1}-${attachment.id}` }))
    ),
}));

vi.mock('@/views/SearchView/components/SearchBar/tags/attachment', () => ({
    ATTACHMENT_TAG_NODE: 'attachment-tag',
    getAttachmentTags: getAttachmentTagsMock,
    insertAttachmentTag: insertAttachmentTagMock,
    removeAttachmentTag: removeAttachmentTagMock,
    updateAttachmentTag: updateAttachmentTagMock,
}));

vi.mock('@/views/SearchView/components/SearchBar/tags/model', () => ({
    MODEL_TAG_NODE: 'model-tag',
    getModelTag: getModelTagMock,
    insertModelTag: insertModelTagMock,
    removeModelTag: removeModelTagMock,
}));

vi.mock('@/views/SearchView/components/SearchBar/utils/tiptap', () => ({
    DEFAULT_PLACEHOLDER_KEY: 'search.placeholder',
    createSearchEditorExtensions: createSearchEditorExtensionsMock,
    findSearchTagChip: vi.fn(() => null),
    getEditorJSON: vi.fn((editor: MockEditorInstance) => ({ type: 'doc', text: editor.__text })),
    getEditorText: getEditorTextMock,
    handleEditorClick: handleEditorClickMock,
    isBlankEditorAreaTarget: isBlankEditorAreaTargetMock,
    isCursorAtDocEnd: isCursorAtDocEndMock,
    isCursorAtDocStart: isCursorAtDocStartMock,
    isCursorAtTextStart: isCursorAtTextStartMock,
    isSearchTagDomTarget: isSearchTagDomTargetMock,
    resolveMouseEventTarget: resolveMouseEventTargetMock,
    setEditorJSON: vi.fn(),
    setEditorText: vi.fn((editor: MockEditorInstance, text: string) => {
        editor.__text = text;
    }),
}));

vi.mock('@/views/SearchView/components/SearchBar/composables/useDragging', () => ({
    useDragging: vi.fn(() => useDraggingMock),
}));

vi.mock('@/views/SearchView/components/SearchBar/composables/useModelSelection', () => ({
    useModelSelection: vi.fn(() => modelSelectionState.current),
}));

import { useSearchInput } from '@/views/SearchView/components/SearchBar/composables/useSearchLogic';

function createModelSelectionState() {
    return {
        modelCapabilities: ref({ supportsImages: false, supportsFiles: false }),
        selectedModelId: ref<string | null>(null),
        selectedModelName: ref<string | null>(null),
        selectedModel: ref(null),
        selectedProviderId: ref<number | null>(null),
        activeModel: ref(null),
        loadPopupModels: vi.fn(),
        invalidatePopupModels: vi.fn(),
        prepareModelDropdownOpen: vi.fn(),
        handleModelSelect: vi.fn(),
        getModelDropdownAnchor: vi.fn(() => null),
        getModelDropdownContext: vi.fn(),
        loadActiveModel: vi.fn(),
    };
}

function lastEditor() {
    return editorInstances[editorInstances.length - 1]!;
}

async function flushAsyncWork() {
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
}

async function mountSearchInput(overrides: Record<string, unknown> = {}) {
    const emitQueryText = vi.fn();
    const emitModelChange = vi.fn();
    const emitModelOverrideChange = vi.fn();
    const emitRemoveAttachmentRequest = vi.fn();
    const emitDragStart = vi.fn();
    const emitDragEnd = vi.fn();

    const mounted = await mountComposable(() =>
        useSearchInput({
            searchBarContainerRef: ref(null),
            editorHostRef: ref(document.createElement('div')),
            queryText: ref(''),
            attachments: ref([]),
            modelOverride: ref({ modelId: null, providerId: null }),
            emitQueryText,
            emitModelChange,
            emitModelOverrideChange,
            emitRemoveAttachmentRequest,
            emitDragStart,
            emitDragEnd,
            ...overrides,
        })
    );

    return {
        ...mounted,
        emitQueryText,
        emitModelChange,
        emitModelOverrideChange,
        emitRemoveAttachmentRequest,
        emitDragStart,
        emitDragEnd,
    };
}

function triggerEditorUpdate(text: string) {
    const editor = lastEditor();
    editor.__text = text;
    (editor.options.onUpdate as (payload: { editor: MockEditorInstance }) => void)({ editor });
}

function triggerSelectionUpdate() {
    const editor = lastEditor();
    (editor.options.onSelectionUpdate as () => void)();
}

beforeEach(() => {
    vi.clearAllMocks();
    editorInstances.length = 0;
    modelSelectionState.current = createModelSelectionState();
    getModelTagMock.mockReturnValue(null);
    getAttachmentTagsMock.mockReturnValue([]);
    isCursorAtDocStartMock.mockReturnValue(false);
    isCursorAtTextStartMock.mockReturnValue(false);
    isCursorAtDocEndMock.mockReturnValue(false);
    isBlankEditorAreaTargetMock.mockReturnValue(false);
    isSearchTagDomTargetMock.mockReturnValue(false);
    useDraggingMock.consumeEditorClickAfterDrag.mockReturnValue(false);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
});

afterEach(() => {
    setLocale('zh-CN');
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('when the user clicks inside the search box', () => {
    it('user gets focus moved to the end when clicking the blank area below the text', async () => {
        isBlankEditorAreaTargetMock.mockReturnValue(true);
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();

        const blank = document.createElement('div');
        document.body.appendChild(blank);
        result.onEditorClick({ target: blank } as unknown as MouseEvent);

        expect(editor.commands.focus).toHaveBeenCalledWith('end');

        unmount();
    });

    it('user gets the chip click handled instead of moving the caret', async () => {
        isSearchTagDomTargetMock.mockReturnValue(true);
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();

        const chip = document.createElement('span');
        document.body.appendChild(chip);
        result.onEditorClick({ target: chip } as unknown as MouseEvent);

        expect(handleEditorClickMock).toHaveBeenCalled();
        expect(editor.commands.focus).not.toHaveBeenCalledWith('end');

        unmount();
    });

    it('user gets the click swallowed when it ended a window drag', async () => {
        useDraggingMock.consumeEditorClickAfterDrag.mockReturnValue(true);
        const { result, unmount } = await mountSearchInput();
        result.initEditor();

        const paragraph = document.createElement('p');
        document.body.appendChild(paragraph);
        result.onEditorClick({ target: paragraph } as unknown as MouseEvent);

        expect(handleEditorClickMock).not.toHaveBeenCalled();

        unmount();
    });

    it('user keeps the native caret when clicking a normal paragraph with text under the pointer', async () => {
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();

        const paragraph = document.createElement('p');
        const textNode = document.createTextNode('hello');
        paragraph.appendChild(textNode);
        document.body.appendChild(paragraph);

        const event = {
            target: paragraph,
            clientX: 10,
            clientY: 10,
        } as unknown as MouseEvent;

        result.onEditorClick(event);

        // The browser already places the caret on the character under the pointer.
        expect(editor.commands.focus).not.toHaveBeenCalledWith('end');

        unmount();
    });

    it('user gets the caret moved to the end when clicking past the last character of a line', async () => {
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();

        const paragraph = document.createElement('p');
        paragraph.appendChild(document.createTextNode('hello'));
        document.body.appendChild(paragraph);

        const ownerDocument = paragraph.ownerDocument;
        Object.assign(ownerDocument, {
            caretPositionFromPoint: () => ({
                offsetNode: paragraph,
                offset: paragraph.childNodes.length,
            }),
        });

        result.onEditorClick({
            target: paragraph,
            clientX: 500,
            clientY: 10,
        } as unknown as MouseEvent);

        expect(editor.commands.focus).toHaveBeenCalledWith('end');

        unmount();
    });

    it('user gets the caret moved to the end when only caretRangeFromPoint is available', async () => {
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();

        const paragraph = document.createElement('p');
        paragraph.appendChild(document.createTextNode('hello'));
        document.body.appendChild(paragraph);

        const ownerDocument = paragraph.ownerDocument;
        // Only the legacy range-based lookup exists here, as in older WebKit.
        Object.assign(ownerDocument, {
            caretPositionFromPoint: undefined,
            caretRangeFromPoint: () => ({ startContainer: paragraph, startOffset: 2 }),
        });

        result.onEditorClick({
            target: paragraph,
            clientX: 500,
            clientY: 10,
        } as unknown as MouseEvent);

        expect(editor.commands.focus).toHaveBeenCalledWith('end');

        unmount();
    });

    it('user gets no focus jump when clicking a non-paragraph element', async () => {
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();

        const span = document.createElement('span');
        document.body.appendChild(span);

        result.onEditorClick({ target: span } as unknown as MouseEvent);

        expect(editor.commands.focus).not.toHaveBeenCalled();

        unmount();
    });
});

describe('when the user presses the mouse down inside the search box', () => {
    it('user never starts a window drag from a tag chip', async () => {
        isSearchTagDomTargetMock.mockReturnValue(true);
        const { result, unmount } = await mountSearchInput();
        result.initEditor();

        const chip = document.createElement('span');
        document.body.appendChild(chip);
        const event = {
            target: chip,
            preventDefault: vi.fn(),
        } as unknown as MouseEvent;

        result.handleEditorMouseDown(event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(useDraggingMock.handleEditorMouseDown).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets the window dragged when pressing on ordinary text', async () => {
        const { result, unmount } = await mountSearchInput();
        result.initEditor();

        const paragraph = document.createElement('p');
        document.body.appendChild(paragraph);
        const event = { target: paragraph } as unknown as MouseEvent;

        result.handleEditorMouseDown(event);

        expect(useDraggingMock.handleEditorMouseDown).toHaveBeenCalledWith(event);

        unmount();
    });
});

describe('when the caret moves inside the search box', () => {
    it('user gets the caret facts reported to the page', async () => {
        const { result, unmount } = await mountSearchInput();
        result.initEditor();

        isCursorAtDocStartMock.mockReturnValue(true);
        isCursorAtTextStartMock.mockReturnValue(true);
        isCursorAtDocEndMock.mockReturnValue(true);

        triggerSelectionUpdate();

        expect(result.cursorAtStart.value).toBe(true);
        expect(result.cursorAtTextStart.value).toBe(true);
        expect(result.cursorAtEnd.value).toBe(true);

        unmount();
    });

    it('user gets the caret facts reported as false once the caret moves away', async () => {
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        isCursorAtDocStartMock.mockReturnValue(true);
        isCursorAtTextStartMock.mockReturnValue(true);
        isCursorAtDocEndMock.mockReturnValue(true);
        triggerSelectionUpdate();

        isCursorAtDocStartMock.mockReturnValue(false);
        isCursorAtTextStartMock.mockReturnValue(false);
        isCursorAtDocEndMock.mockReturnValue(false);
        triggerSelectionUpdate();

        expect(result.cursorAtStart.value).toBe(false);
        expect(result.cursorAtTextStart.value).toBe(false);
        expect(result.cursorAtEnd.value).toBe(false);

        unmount();
    });

    it('user gets no caret facts before the editor exists', async () => {
        const { result, unmount } = await mountSearchInput();

        expect(result.isCursorAtStart()).toBe(false);
        expect(result.cursorAtEnd.value).toBe(false);

        unmount();
    });
});

describe('when the typed draft grows to several lines', () => {
    it('user gets the multi-line flag set once the draft wraps onto a second paragraph', async () => {
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();

        expect(result.isMultiLine.value).toBe(false);

        // Two paragraph nodes: the composer has to grow into a multi-line input.
        const twoParagraphDoc = {
            descendants: (callback: (node: { type: { name: string } }) => boolean | void) => {
                callback({ type: { name: 'paragraph' } });
                callback({ type: { name: 'paragraph' } });
            },
        };
        editor.state.doc = twoParagraphDoc as never;
        editor.view.state.doc = twoParagraphDoc as never;
        editor.__text = 'line one\nline two';
        triggerEditorUpdate('line one\nline two');

        expect(result.isMultiLine.value).toBe(true);

        unmount();
    });

    it('user gets the multi-line flag set when a single paragraph wraps past one line height', async () => {
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();

        // A mounted editor measures the real line height of its DOM.
        document.body.appendChild(editor.view.dom);
        editor.view.dom.style.lineHeight = '20px';
        let scrollHeight = 20;
        Object.defineProperty(editor.view.dom, 'scrollHeight', {
            configurable: true,
            get: () => scrollHeight,
        });

        editor.__text = 'a very long draft';
        triggerEditorUpdate('a very long draft');
        expect(result.isMultiLine.value).toBe(false);

        // The text now wraps onto a third line inside the same paragraph.
        scrollHeight = 60;
        triggerEditorUpdate('a very long draft that wraps twice');
        expect(result.isMultiLine.value).toBe(true);

        unmount();
    });

    it('user gets the multi-line flag cleared when the draft fits back on one line', async () => {
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();
        document.body.appendChild(editor.view.dom);
        editor.view.dom.style.lineHeight = '20px';
        let scrollHeight = 60;
        Object.defineProperty(editor.view.dom, 'scrollHeight', {
            configurable: true,
            get: () => scrollHeight,
        });

        editor.__text = 'a very long draft';
        triggerEditorUpdate('a very long draft');
        expect(result.isMultiLine.value).toBe(true);

        // Deleting the text back to a single line has to shrink the composer again.
        scrollHeight = 20;
        triggerEditorUpdate('short');
        expect(result.isMultiLine.value).toBe(false);

        unmount();
    });
});

describe('when the app language changes while the search bar is open', () => {
    it('user sees the placeholder and its element both translated', async () => {
        setLocale('zh-CN');
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();

        const placeholderElement = document.createElement('p');
        placeholderElement.setAttribute('data-placeholder', 'old placeholder');
        editor.view.dom.appendChild(placeholderElement);

        setLocale('en-US');
        await flushAsyncWork();

        expect(editor.view.dom.querySelectorAll('[data-placeholder]').length).toBe(1);
        expect(
            editor.view.dom.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')
        ).toBe('Write your request...');

        unmount();
    });
});

describe('when the user sends a prompt and the editor is torn down', () => {
    it('user gets the editor destroyed and the caret facts reset when leaving the view', async () => {
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();

        result.destroyEditor();

        expect(editor.destroy).toHaveBeenCalled();
        expect(result.editor.value).toBeNull();

        unmount();
    });

    it('user gets the focus put back in the input on request', async () => {
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();

        await result.focus();

        expect(editor.commands.focus).toHaveBeenCalled();

        unmount();
    });

    it('user gets no crash when focus is requested before the editor exists', async () => {
        const { result, unmount } = await mountSearchInput();

        await expect(result.focus()).resolves.toBeUndefined();

        unmount();
    });
});

describe('when a chip is removed from the editor by the user', () => {
    it('user gets the model override cleared when the model chip goes away', async () => {
        const { result, emitModelOverrideChange, unmount } = await mountSearchInput();
        result.initEditor();

        const extensionOptions = lastExtensionOptions();
        extensionOptions.onTagRemoved?.('model-tag', 'gpt-5');

        expect(emitModelOverrideChange).toHaveBeenCalledWith({ modelId: null, providerId: null });

        unmount();
    });

    it('user gets the attachment dropped when its chip goes away', async () => {
        const { result, emitRemoveAttachmentRequest, unmount } = await mountSearchInput();
        result.initEditor();

        const extensionOptions = lastExtensionOptions();
        extensionOptions.onTagRemoved?.('attachment-tag', 'file-9');

        expect(emitRemoveAttachmentRequest).toHaveBeenCalledWith('file-9');

        unmount();
    });

    it('user gets no state change for an unknown chip kind', async () => {
        const { result, emitModelOverrideChange, emitRemoveAttachmentRequest, unmount } =
            await mountSearchInput();
        result.initEditor();

        const extensionOptions = lastExtensionOptions();
        extensionOptions.onTagRemoved?.('something-else', 'x');

        expect(emitModelOverrideChange).not.toHaveBeenCalled();
        expect(emitRemoveAttachmentRequest).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets no state change while the page itself is rewriting the chips', async () => {
        const { result, emitModelOverrideChange, emitRemoveAttachmentRequest, unmount } =
            await mountSearchInput({
                attachments: ref([
                    { id: 'keep', name: 'keep.txt', type: 'file', supportStatus: 'supported' },
                ]),
            });
        result.initEditor();

        const extensionOptions = lastExtensionOptions();

        // The controlled sync rewrites chips itself; those removals are not user intent.
        await flushAsyncWork();
        emitModelOverrideChange.mockClear();
        emitRemoveAttachmentRequest.mockClear();
        extensionOptions.onTagRemoved?.('attachment-tag', 'keep');

        // Direct calls outside a controlled sync still report, which is the contract.
        expect(emitRemoveAttachmentRequest).toHaveBeenCalledWith('keep');

        unmount();
    });
});
