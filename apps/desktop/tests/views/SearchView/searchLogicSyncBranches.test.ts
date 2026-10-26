import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { setLocale } from '@/i18n';
import { createInputHistorySnapshot } from '@/types/session';

/**
 * Second pass over useSearchInput: the attachment diff (changed metadata vs an
 * unchanged chip), the caret-scroll branch where the caret is taller than the box,
 * and the guard that keeps the locale refresh from rewriting the placeholder while
 * the editor is mid-restore. The editor is stubbed at the tiptap boundary only.
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
    useDragging: vi.fn(() => ({
        handleContainerMouseDown: vi.fn(),
        handleEditorMouseDown: vi.fn(),
        consumeEditorClickAfterDrag: vi.fn(() => false),
        clearEditorSelectionDragState: vi.fn(),
    })),
}));
vi.mock('@/views/SearchView/components/SearchBar/composables/useModelSelection', () => ({
    useModelSelection: vi.fn(() => modelSelectionState.current),
}));

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
            emitModelChange: vi.fn(),
            emitModelOverrideChange,
            emitRemoveAttachmentRequest,
            emitDragStart: vi.fn(),
            emitDragEnd: vi.fn(),
            ...overrides,
        })
    );

    return { ...mounted, emitQueryText, emitModelOverrideChange, emitRemoveAttachmentRequest };
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
    setLocale('zh-CN');
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('when the caret is taller than the visible search box', () => {
    it('user gets the box scrolled by the overflow below the fold', async () => {
        const editorHost = document.createElement('div');
        Object.defineProperty(editorHost, 'clientHeight', { configurable: true, value: 20 });
        editorHost.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
        editorHost.scrollTop = 0;

        const { result, unmount } = await mountSearchInput({ editorHostRef: ref(editorHost) });
        result.initEditor();
        const editor = lastEditor();
        // The caret starts below the box top but its bottom edge hangs past the fold.
        editor.view.coordsAtPos.mockReturnValue({ top: 6, bottom: 60 });

        (editor.options.onUpdate as (payload: { editor: MockEditorInstance }) => void)({ editor });

        expect(editorHost.scrollTop).toBeGreaterThan(0);

        unmount();
    });
});

describe('when the page rewrites an attachment chip', () => {
    const currentTag = {
        attachmentId: 'file-1',
        // Must match what the page computes for this attachment, or the chip is
        // legitimately rewritten because its alias changed.
        alias: 'A1-file-1',
        fileName: 'file-1.txt',
        fileType: 'file',
        supportStatus: 'supported',
    };

    it('user gets the chip updated when its displayed name changed', async () => {
        getAttachmentTagsMock.mockReturnValue([currentTag]);
        const attachments = ref([createAttachment('file-1')]);

        const { result, unmount } = await mountSearchInput({ attachments });
        result.initEditor();
        const editor = lastEditor();
        vi.clearAllMocks();

        // Same id, new file name: the chip's label has to follow.
        attachments.value = [createAttachment('file-1', { name: 'renamed.txt' })];
        await flushAsyncWork();

        expect(updateAttachmentTagMock).toHaveBeenCalledWith(
            editor,
            expect.objectContaining({ attachmentId: 'file-1', fileName: 'renamed.txt' })
        );

        unmount();
    });

    it('user gets no chip rewrite when nothing about it changed', async () => {
        getAttachmentTagsMock.mockReturnValue([currentTag]);
        const attachments = ref([createAttachment('file-1')]);

        const { result, unmount } = await mountSearchInput({ attachments });
        result.initEditor();
        vi.clearAllMocks();

        // Re-reporting the identical attachment must not touch the document.
        attachments.value = [createAttachment('file-1')];
        await flushAsyncWork();

        expect(updateAttachmentTagMock).not.toHaveBeenCalled();
        expect(insertAttachmentTagMock).not.toHaveBeenCalled();
        expect(removeAttachmentTagMock).not.toHaveBeenCalled();

        unmount();
    });
});

describe('when the page replaces the draft after a recall', () => {
    it('user gets the page draft applied once the recall has settled', async () => {
        const queryText = ref('original');
        const { result, unmount } = await mountSearchInput({ queryText });
        result.initEditor();
        const editor = lastEditor();

        result.restoreInputHistorySnapshot(
            createInputHistorySnapshot({ text: 'recalled', attachments: [] })
        );
        await flushAsyncWork();

        queryText.value = 'page rewrite after recall';
        await flushAsyncWork();

        expect(editor.__text).toBe('page rewrite after recall');

        unmount();
    });
});

describe('when the model name is not resolvable but the id matches', () => {
    it('user keeps the existing chip instead of flickering it away', async () => {
        getModelTagMock.mockReturnValue({ modelId: 'gpt-5', modelName: 'GPT-5', providerId: 1 });
        const modelSelection = createModelSelectionState();
        modelSelection.selectedModelId.value = 'gpt-5';
        modelSelection.selectedModelName.value = 'GPT-5';
        modelSelection.selectedProviderId.value = 1;
        modelSelectionState.current = modelSelection;

        const { result, unmount } = await mountSearchInput();
        result.initEditor();
        vi.clearAllMocks();

        // The name resolution lapses but the id is unchanged: the chip stays put.
        modelSelection.selectedModelName.value = null;
        await flushAsyncWork();

        expect(removeModelTagMock).not.toHaveBeenCalled();
        expect(insertModelTagMock).not.toHaveBeenCalled();

        unmount();
    });
});
