import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

/**
 * useSearchInput keeps the editor and the page in sync in both directions: it
 * projects the controlled model/attachment draft into the editor, and it keeps the
 * caret visible while the user types. The editor is a tiptap view that cannot mount
 * in jsdom, so it is replaced at the `@tiptap/vue-3` boundary with a stand-in that
 * keeps the same small surface. Every assertion is about the state the page sees or
 * the tag operation performed on the editor.
 */
const {
    createSearchEditorExtensionsMock,
    editorInstances,
    getAttachmentTagsMock,
    getEditorTextMock,
    getModelTagMock,
    insertAttachmentTagMock,
    insertModelTagMock,
    MockEditor,
    modelSelectionState,
    removeAttachmentTagMock,
    removeModelTagMock,
    setEditorJSONMock,
    setEditorTextMock,
    updateAttachmentTagMock,
    useDraggingMock,
} = vi.hoisted(() => {
    class MockEditor {
        __text = '';
        __json: Record<string, unknown> = { type: 'doc', content: [] };
        commands = { focus: vi.fn() };
        destroy = vi.fn();
        options: Record<string, unknown>;
        state: {
            selection: { empty: boolean; from: number; to: number; $anchor: { pos: number } };
            doc: {
                descendants: (cb: (node: { type: { name: string } }) => boolean | void) => void;
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
                selection: { empty: true, from: 1, to: 1, $anchor: { pos: 1 } },
                doc: {
                    descendants: (cb: (node: { type: { name: string } }) => boolean | void) => {
                        cb({ type: { name: 'paragraph' } });
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
            this.view.dom.style.lineHeight = '20px';
            Object.defineProperty(this.view.dom, 'scrollHeight', { configurable: true, value: 20 });
            editorInstances.push(this);
        }
    }

    return {
        createSearchEditorExtensionsMock: vi.fn((options?: unknown) => {
            void options;
            return [];
        }),
        editorInstances: [] as MockEditor[],
        getAttachmentTagsMock: vi.fn<() => Array<Record<string, unknown>>>(() => []),
        getEditorTextMock: vi.fn((editor: MockEditor) => editor.__text),
        getModelTagMock: vi.fn<() => Record<string, unknown> | null>(() => null),
        insertAttachmentTagMock: vi.fn(),
        insertModelTagMock: vi.fn(),
        MockEditor,
        modelSelectionState: { current: null as null | Record<string, unknown> },
        removeAttachmentTagMock: vi.fn(),
        removeModelTagMock: vi.fn(),
        setEditorJSONMock: vi.fn((editor: MockEditor, json: Record<string, unknown>) => {
            editor.__json = json;
            editor.__text = String(json.text ?? '');
        }),
        setEditorTextMock: vi.fn((editor: MockEditor, text: string) => {
            editor.__text = text;
        }),
        updateAttachmentTagMock: vi.fn(),
        useDraggingMock: {
            handleContainerMouseDown: vi.fn(),
            handleEditorMouseDown: vi.fn(),
            consumeEditorClickAfterDrag: vi.fn(() => false),
            clearEditorSelectionDragState: vi.fn(),
        },
    };
});

vi.mock('@/views/SearchView/components/SearchBar/tags', () => ({}));
vi.mock('@tiptap/vue-3', () => ({ Editor: MockEditor }));
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
    getEditorJSON: vi.fn((editor: { __json: Record<string, unknown> }) => editor.__json),
    getEditorText: getEditorTextMock,
    handleEditorClick: vi.fn(),
    isBlankEditorAreaTarget: vi.fn(() => false),
    isCursorAtDocEnd: vi.fn(() => false),
    isCursorAtDocStart: vi.fn(() => false),
    isCursorAtTextStart: vi.fn(() => false),
    isSearchTagDomTarget: vi.fn(() => false),
    resolveMouseEventTarget: vi.fn((event: MouseEvent) => event.target as HTMLElement),
    setEditorJSON: setEditorJSONMock,
    setEditorText: setEditorTextMock,
}));
vi.mock('@/views/SearchView/components/SearchBar/composables/useDragging', () => ({
    useDragging: vi.fn(() => useDraggingMock),
}));
vi.mock('@/views/SearchView/components/SearchBar/composables/useModelSelection', () => ({
    useModelSelection: vi.fn(() => modelSelectionState.current),
}));

import { createInputHistorySnapshot } from '@/types/session';
import { useSearchInput } from '@/views/SearchView/components/SearchBar/composables/useSearchLogic';

interface MockEditorInstance {
    __text: string;
    __json: Record<string, unknown>;
    commands: { focus: ReturnType<typeof vi.fn> };
    options: Record<string, unknown>;
    state: {
        selection: { empty: boolean; from: number; to: number; $anchor: { pos: number } };
        doc: { descendants: (cb: (node: { type: { name: string } }) => boolean | void) => void };
    };
    view: {
        dom: HTMLElement;
        dispatch: ReturnType<typeof vi.fn>;
        coordsAtPos: ReturnType<typeof vi.fn>;
        state: {
            selection: { empty: boolean; from: number; to: number; $anchor: { pos: number } };
        };
    };
}

function lastEditor(): MockEditorInstance {
    const instances = editorInstances as unknown as MockEditorInstance[];
    return instances[instances.length - 1]!;
}

function createModelSelectionState(overrides: Record<string, unknown> = {}) {
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
        ...overrides,
    };
}

async function flushAsyncWork() {
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
}

function createAttachment(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        type: 'file' as const,
        name: `${id}.txt`,
        path: `D:/${id}.txt`,
        originPath: `D:/${id}.txt`,
        supportStatus: 'supported' as const,
        ...overrides,
    };
}

async function mountSearchInput(overrides: Record<string, unknown> = {}) {
    const emitQueryText = vi.fn();
    const emitModelChange = vi.fn();
    const emitModelOverrideChange = vi.fn();
    const emitRemoveAttachmentRequest = vi.fn();

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
            emitDragStart: vi.fn(),
            emitDragEnd: vi.fn(),
            ...overrides,
        })
    );

    return {
        ...mounted,
        emitQueryText,
        emitModelChange,
        emitModelOverrideChange,
        emitRemoveAttachmentRequest,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    editorInstances.length = 0;
    modelSelectionState.current = createModelSelectionState();
    getModelTagMock.mockReturnValue(null);
    getAttachmentTagsMock.mockReturnValue([]);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('when the user types in a draft taller than the search box', () => {
    it('user gets the box scrolled so the caret stays visible below the fold', async () => {
        const editorHost = document.createElement('div');
        Object.defineProperty(editorHost, 'clientHeight', { configurable: true, value: 60 });
        editorHost.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
        editorHost.scrollTop = 0;

        const { result, unmount } = await mountSearchInput({ editorHostRef: ref(editorHost) });
        result.initEditor();
        const editor = lastEditor();
        // Caret sits below the visible 60px box.
        editor.view.coordsAtPos.mockReturnValue({ top: 120, bottom: 140 });

        (editor.options.onUpdate as (payload: { editor: MockEditorInstance }) => void)({ editor });

        expect(editorHost.scrollTop).toBeGreaterThan(0);

        unmount();
    });

    it('user gets the box scrolled up when the caret is above the visible area', async () => {
        const editorHost = document.createElement('div');
        Object.defineProperty(editorHost, 'clientHeight', { configurable: true, value: 60 });
        editorHost.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
        editorHost.scrollTop = 100;

        const { result, unmount } = await mountSearchInput({ editorHostRef: ref(editorHost) });
        result.initEditor();
        const editor = lastEditor();
        editor.view.coordsAtPos.mockReturnValue({ top: -40, bottom: -20 });

        (editor.options.onUpdate as (payload: { editor: MockEditorInstance }) => void)({ editor });

        expect(editorHost.scrollTop).toBeLessThan(100);

        unmount();
    });

    it('user gets no scroll when the caret is already fully visible', async () => {
        const editorHost = document.createElement('div');
        Object.defineProperty(editorHost, 'clientHeight', { configurable: true, value: 60 });
        editorHost.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
        editorHost.scrollTop = 0;

        const { result, unmount } = await mountSearchInput({ editorHostRef: ref(editorHost) });
        result.initEditor();
        const editor = lastEditor();
        editor.view.coordsAtPos.mockReturnValue({ top: 20, bottom: 40 });

        (editor.options.onUpdate as (payload: { editor: MockEditorInstance }) => void)({ editor });

        expect(editorHost.scrollTop).toBe(0);

        unmount();
    });

    it('user gets no scroll while a selection is active so the drag is not disturbed', async () => {
        const editorHost = document.createElement('div');
        Object.defineProperty(editorHost, 'clientHeight', { configurable: true, value: 60 });
        editorHost.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
        editorHost.scrollTop = 5;

        const { result, unmount } = await mountSearchInput({ editorHostRef: ref(editorHost) });
        result.initEditor();
        const editor = lastEditor();
        editor.state.selection.empty = false;
        editor.view.coordsAtPos.mockReturnValue({ top: 500, bottom: 520 });

        (editor.options.onUpdate as (payload: { editor: MockEditorInstance }) => void)({ editor });

        expect(editorHost.scrollTop).toBe(5);

        unmount();
    });
});

describe('when the page projects the chosen model into the editor', () => {
    it('user gets the chip removed when the page clears the model override', async () => {
        getModelTagMock.mockReturnValue({ modelId: 'gpt-5', modelName: 'GPT-5', providerId: 1 });
        const modelSelection = createModelSelectionState();
        modelSelection.selectedModelId.value = 'gpt-5';
        modelSelection.selectedModelName.value = 'GPT-5';
        modelSelection.selectedProviderId.value = 1;
        modelSelectionState.current = modelSelection;

        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();
        vi.clearAllMocks();

        // The page clears the pick, so the chip must go with it.
        modelSelection.selectedModelId.value = null;
        modelSelection.selectedProviderId.value = null;
        await flushAsyncWork();

        expect(removeModelTagMock).toHaveBeenCalledWith(editor);

        unmount();
    });

    it('user gets no chip churn when the override already matches the editor', async () => {
        getModelTagMock.mockReturnValue({ modelId: 'gpt-5', modelName: 'GPT-5', providerId: 1 });
        const modelSelection = createModelSelectionState();
        modelSelection.selectedModelId.value = 'gpt-5';
        modelSelection.selectedModelName.value = 'GPT-5';
        modelSelection.selectedProviderId.value = 1;
        modelSelectionState.current = modelSelection;

        const { result, unmount } = await mountSearchInput();
        result.initEditor();

        vi.clearAllMocks();
        await flushAsyncWork();

        // Rewriting an identical chip would disturb the caret for no reason.
        expect(insertModelTagMock).not.toHaveBeenCalled();
        expect(removeModelTagMock).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets the chip removed when the page knows the model id but not its name', async () => {
        getModelTagMock.mockReturnValue({ modelId: 'old-model', modelName: 'Old', providerId: 1 });
        const modelSelection = createModelSelectionState();
        modelSelection.selectedModelId.value = 'old-model';
        modelSelection.selectedModelName.value = 'Old';
        modelSelection.selectedProviderId.value = 1;
        modelSelectionState.current = modelSelection;

        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();
        vi.clearAllMocks();

        // A different id with no resolvable name: the stale chip cannot stay.
        modelSelection.selectedModelId.value = 'new-model';
        modelSelection.selectedModelName.value = null;
        await flushAsyncWork();

        expect(removeModelTagMock).toHaveBeenCalledWith(editor);

        unmount();
    });
});

describe('when the page projects the attachment list into the editor', () => {
    it('user gets a chip dropped when the page removed that attachment', async () => {
        getAttachmentTagsMock.mockReturnValue([
            {
                attachmentId: 'file-1',
                alias: 'A1',
                fileName: 'file-1.txt',
                fileType: 'file',
                supportStatus: 'supported',
            },
        ]);
        const attachments = ref([createAttachment('file-1')]);

        const { result, unmount } = await mountSearchInput({ attachments });
        result.initEditor();
        const editor = lastEditor();

        vi.clearAllMocks();
        attachments.value = [];
        await flushAsyncWork();

        expect(removeAttachmentTagMock).toHaveBeenCalledWith(editor, 'file-1');

        unmount();
    });

    it('user gets a chip updated in place when the page changes its metadata', async () => {
        getAttachmentTagsMock.mockReturnValue([
            {
                attachmentId: 'file-1',
                alias: 'A1',
                fileName: 'file-1.txt',
                fileType: 'file',
                supportStatus: 'supported',
            },
        ]);
        // The same attachment listed, but the page now marks it unsupported.
        const attachments = ref([
            createAttachment('file-1', { supportStatus: 'unsupported-file' }),
        ]);

        const { result, unmount } = await mountSearchInput({ attachments });
        result.initEditor();
        const editor = lastEditor();

        vi.clearAllMocks();
        attachments.value = [
            createAttachment('file-1', { supportStatus: 'unsupported-file' }),
            createAttachment('file-2'),
        ];
        await flushAsyncWork();

        // The changed chip is updated rather than torn down and re-added.
        expect(updateAttachmentTagMock).toHaveBeenCalledWith(
            editor,
            expect.objectContaining({ attachmentId: 'file-1' })
        );
        expect(insertAttachmentTagMock).toHaveBeenCalledTimes(1);

        unmount();
    });

    it('user gets both chips at the same draft offset kept in their original order', async () => {
        const attachments = ref<Array<Record<string, unknown>>>([]);

        const { result, unmount } = await mountSearchInput({ attachments });
        result.initEditor();

        vi.clearAllMocks();
        attachments.value = [
            createAttachment('img-a', { type: 'image', draftInsertionOffset: 3 }),
            createAttachment('img-b', { type: 'image', draftInsertionOffset: 3 }),
        ];
        await flushAsyncWork();

        expect(insertAttachmentTagMock).toHaveBeenCalledTimes(2);
        const firstOptions = insertAttachmentTagMock.mock.calls[0]![2] as {
            textOffset: number;
            sameOffsetIndex: number;
        };
        const secondOptions = insertAttachmentTagMock.mock.calls[1]![2] as {
            textOffset: number;
            sameOffsetIndex: number;
        };
        // Pasted images sharing one offset must keep their relative order.
        expect(firstOptions).toEqual({ textOffset: 3, sameOffsetIndex: 0 });
        expect(secondOptions).toEqual({ textOffset: 3, sameOffsetIndex: 1 });

        unmount();
    });
});

describe('when the user recalls an earlier prompt', () => {
    it('user gets the structured draft restored including its chips', async () => {
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();

        vi.clearAllMocks();
        const restored = result.restoreInputHistorySnapshot(
            createInputHistorySnapshot({
                text: 'remembered',
                attachments: [createAttachment('file-9')],
                editorDoc: { type: 'doc', text: 'remembered' },
            })
        );

        expect(restored).toBe('remembered');
        expect(setEditorJSONMock).toHaveBeenCalledWith(
            editor,
            expect.objectContaining({ type: 'doc' })
        );
        // The recalled prompt's attachment comes back with it.
        expect(insertAttachmentTagMock).toHaveBeenCalled();

        unmount();
    });

    it('user gets a plain-text restore when the snapshot has no structured document', async () => {
        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        const editor = lastEditor();

        vi.clearAllMocks();
        const restored = result.restoreInputHistorySnapshot(
            createInputHistorySnapshot({ text: 'plain only', attachments: [] })
        );

        expect(restored).toBe('plain only');
        expect(setEditorTextMock).toHaveBeenCalledWith(editor, 'plain only');

        unmount();
    });

    it('user gets the recalled text back even before the editor exists', async () => {
        const { result, unmount } = await mountSearchInput();

        const restored = result.restoreInputHistorySnapshot(
            createInputHistorySnapshot({ text: 'too early', attachments: [] })
        );

        expect(restored).toBe('too early');
        expect(editorInstances).toHaveLength(0);

        unmount();
    });

    it('user gets a plain-text snapshot fallback captured before the editor exists', async () => {
        const queryText = ref('typed before mount');
        const { result, unmount } = await mountSearchInput({ queryText });

        const snapshot = result.captureInputHistorySnapshot();

        expect(snapshot.text).toBe('typed before mount');
        expect(snapshot.editorDoc).toBeUndefined();

        unmount();
    });
});

describe('when the editor is still mounting', () => {
    it('user gets no caret-state churn reported while the editor is missing', async () => {
        const { result, unmount } = await mountSearchInput();

        expect(result.isCursorAtStart()).toBe(false);
        expect(result.cursorAtStart.value).toBe(false);
        expect(result.cursorAtTextStart.value).toBe(false);
        expect(result.cursorAtEnd.value).toBe(false);

        unmount();
    });

    it('user gets no attachment projection attempted before the editor exists', async () => {
        const attachments = ref([createAttachment('early')]);

        const { unmount } = await mountSearchInput({ attachments });
        await flushAsyncWork();

        // Nothing can be projected into an editor that was never created.
        expect(insertAttachmentTagMock).not.toHaveBeenCalled();

        unmount();
    });
});
