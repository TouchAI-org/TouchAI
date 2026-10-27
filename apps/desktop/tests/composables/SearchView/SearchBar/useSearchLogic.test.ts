import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { setLocale } from '@/i18n';
import { createInputHistorySnapshot } from '@/types/session';

type SearchEditorExtensionOptions = {
    placeholder?: string | (() => string);
    onTagRemoved?: (tagType: string, value: string) => void;
};

const {
    editorInstances,
    buildAttachmentPromptMetasMock,
    createSearchEditorExtensionsMock,
    findSearchTagChipMock,
    getAttachmentTagsMock,
    getEditorJSONMock,
    getEditorTextMock,
    getModelTagMock,
    handleEditorClickMock,
    insertAttachmentTagMock,
    insertModelTagMock,
    isBlankEditorAreaTargetMock,
    isCursorAtDocEndMock,
    isCursorAtDocStartMock,
    resolveEditorCursorFlagsMock,
    isCursorAtTextStartMock,
    isSearchTagDomTargetMock,
    MockEditor,
    modelSelectionState,
    removeAttachmentTagMock,
    removeModelTagMock,
    resolveMouseEventTargetMock,
    setEditorJSONMock,
    setEditorTextMock,
    updateAttachmentTagMock,
    useDraggingMock,
} = vi.hoisted(() => {
    class MockEditor {
        options: Record<string, unknown>;
        __text = '';
        __json: Record<string, unknown> = { type: 'doc', content: [] };
        commands = {
            focus: vi.fn(),
        };
        destroy = vi.fn();
        isEmpty = false;
        state = {
            selection: {
                empty: true,
                $anchor: {
                    pos: 1,
                },
            },
            tr: {
                setMeta: vi.fn(() => this.state.tr),
            },
            doc: {
                descendants: (callback: (node: { type: { name: string } }) => boolean | void) => {
                    callback({ type: { name: 'paragraph' } });
                },
            },
        };
        view = {
            dom: document.createElement('div'),
            coordsAtPos: vi.fn(() => ({
                top: 0,
                bottom: 20,
            })),
            dispatch: vi.fn(),
            state: this.state,
        };

        constructor(options: Record<string, unknown>) {
            this.options = options;
            this.view.dom.style.lineHeight = '20px';
            Object.defineProperty(this.view.dom, 'scrollHeight', {
                configurable: true,
                value: 20,
            });
            editorInstances.push(this);
        }
    }

    return {
        editorInstances: [] as MockEditor[],
        buildAttachmentPromptMetasMock: vi.fn(),
        createSearchEditorExtensionsMock: vi.fn((options?: SearchEditorExtensionOptions) => {
            void options;
            return [];
        }),
        findSearchTagChipMock: vi.fn(() => null),
        getAttachmentTagsMock: vi.fn(() => []),
        getEditorJSONMock: vi.fn((editor: MockEditor) => editor.__json),
        getEditorTextMock: vi.fn((editor: MockEditor) => editor.__text),
        getModelTagMock: vi.fn(() => null),
        handleEditorClickMock: vi.fn(),
        insertAttachmentTagMock: vi.fn(),
        insertModelTagMock: vi.fn(),
        isBlankEditorAreaTargetMock: vi.fn(() => false),
        isCursorAtDocEndMock: vi.fn(() => false),
        isCursorAtDocStartMock: vi.fn(() => false),
        resolveEditorCursorFlagsMock: vi.fn(),
        isCursorAtTextStartMock: vi.fn(() => false),
        isSearchTagDomTargetMock: vi.fn(() => false),
        modelSelectionState: {
            current: null as null | Record<string, unknown>,
        },
        removeAttachmentTagMock: vi.fn(),
        removeModelTagMock: vi.fn(),
        resolveMouseEventTargetMock: vi.fn(
            (event: MouseEvent) => event.target as HTMLElement | null
        ),
        setEditorJSONMock: vi.fn((editor: MockEditor, json: Record<string, unknown>) => {
            editor.__json = json;
            editor.__text = String(json.text ?? '');
        }),
        setEditorTextMock: vi.fn((editor: MockEditor, text: string) => {
            editor.__text = text;
            editor.__json = {
                type: 'doc',
                text,
            };
        }),
        updateAttachmentTagMock: vi.fn(),
        useDraggingMock: {
            handleContainerMouseDown: vi.fn(),
            handleEditorMouseDown: vi.fn(),
            consumeEditorClickAfterDrag: vi.fn(() => false),
            clearEditorSelectionDragState: vi.fn(),
        },
        MockEditor,
    };
});

vi.mock('@/views/SearchView/components/SearchBar/tags', () => ({}));

vi.mock('@tiptap/vue-3', () => ({
    Editor: MockEditor,
}));

vi.mock('@/services/AgentService/infrastructure/attachments', () => ({
    buildAttachmentPromptMetas: buildAttachmentPromptMetasMock,
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
    findSearchTagChip: findSearchTagChipMock,
    getEditorJSON: getEditorJSONMock,
    getEditorText: getEditorTextMock,
    handleEditorClick: handleEditorClickMock,
    isBlankEditorAreaTarget: isBlankEditorAreaTargetMock,
    isCursorAtDocEnd: isCursorAtDocEndMock,
    isCursorAtDocStart: isCursorAtDocStartMock,
    resolveEditorCursorFlags: resolveEditorCursorFlagsMock,
    isCursorAtTextStart: isCursorAtTextStartMock,
    isSearchTagDomTarget: isSearchTagDomTargetMock,
    resolveMouseEventTarget: resolveMouseEventTargetMock,
    setEditorJSON: setEditorJSONMock,
    setEditorText: setEditorTextMock,
}));

vi.mock('@/views/SearchView/components/SearchBar/composables/useDragging', () => ({
    useDragging: vi.fn(() => useDraggingMock),
}));

vi.mock('@/views/SearchView/components/SearchBar/composables/useModelSelection', () => ({
    useModelSelection: vi.fn(() => modelSelectionState.current),
}));

import { useSearchInput } from '@/views/SearchView/components/SearchBar/composables/useSearchLogic';

function getModelSelectionMock() {
    return modelSelectionState.current as {
        modelCapabilities: ReturnType<
            typeof ref<{ supportsImages: boolean; supportsFiles: boolean }>
        >;
        selectedModelId: ReturnType<typeof ref<string | null>>;
        selectedModelName: ReturnType<typeof ref<string | null>>;
        selectedModel: ReturnType<typeof ref<unknown>>;
        selectedProviderId: ReturnType<typeof ref<number | null>>;
        activeModel: ReturnType<typeof ref<unknown>>;
        loadPopupModels: ReturnType<typeof vi.fn>;
        invalidatePopupModels: ReturnType<typeof vi.fn>;
        prepareModelDropdownOpen: ReturnType<typeof vi.fn>;
        handleModelSelect: ReturnType<typeof vi.fn>;
        getModelDropdownAnchor: ReturnType<typeof vi.fn>;
        getModelDropdownContext: ReturnType<typeof vi.fn>;
        loadActiveModel: ReturnType<typeof vi.fn>;
    };
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

async function flushAsyncWork() {
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
}

async function mountSearchInput(overrides: Partial<Parameters<typeof useSearchInput>[0]> = {}) {
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

function lastEditor() {
    return editorInstances[editorInstances.length - 1]!;
}

function simulateEditorUpdate(text: string) {
    const editor = lastEditor();
    editor.__text = text;
    (editor.options.onUpdate as (payload: { editor: InstanceType<typeof MockEditor> }) => void)({
        editor,
    });
}

describe('when the search input first appears', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        editorInstances.length = 0;
        modelSelectionState.current = {
            modelCapabilities: ref({
                supportsImages: true,
                supportsFiles: false,
            }),
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
            getModelDropdownContext: vi.fn(() => ({
                activeModelId: null,
                activeProviderId: null,
                selectedModelId: null,
                selectedProviderId: null,
                models: [],
            })),
            loadActiveModel: vi.fn(),
        };
        buildAttachmentPromptMetasMock.mockImplementation((attachments: Array<{ id: string }>) =>
            attachments.map((attachment, index) => ({
                alias: `A${index + 1}-${attachment.id}`,
            }))
        );
        getModelSelectionMock().modelCapabilities.value = {
            supportsImages: true,
            supportsFiles: false,
        };
        getModelSelectionMock().selectedModelId.value = null;
        getModelSelectionMock().selectedModelName.value = null;
        getModelSelectionMock().selectedProviderId.value = null;
        getModelTagMock.mockReturnValue(null);
        getAttachmentTagsMock.mockReturnValue([]);
        isCursorAtDocStartMock.mockReturnValue(false);
        isCursorAtTextStartMock.mockReturnValue(false);
        isCursorAtDocEndMock.mockReturnValue(false);
        resolveEditorCursorFlagsMock.mockImplementation(() => ({
            cursorAtStart: isCursorAtDocStartMock(),
            cursorAtTextStart: isCursorAtTextStartMock(),
            cursorAtEnd: isCursorAtDocEndMock(),
        }));
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

    it('reports multi-line state from a single measurement per update', async () => {
        const mounted = await mountComposable(() =>
            useSearchInput({
                searchBarContainerRef: ref(null),
                editorHostRef: ref(document.createElement('div')),
                queryText: ref(''),
                attachments: ref([]),
                modelOverride: ref({ modelId: null, providerId: null }),
                emitQueryText: vi.fn(),
                emitModelChange: vi.fn(),
                emitModelOverrideChange: vi.fn(),
                emitRemoveAttachmentRequest: vi.fn(),
                emitDragStart: vi.fn(),
                emitDragEnd: vi.fn(),
            })
        );

        mounted.result.initEditor();
        await flushAsyncWork();

        const editor = editorInstances[0]!;
        let scrollReads = 0;
        Object.defineProperty(editor.view.dom, 'scrollHeight', {
            configurable: true,
            get: () => {
                scrollReads += 1;
                return 40;
            },
        });

        (editor.options.onUpdate as (payload: { editor: InstanceType<typeof MockEditor> }) => void)(
            { editor }
        );

        // 同步输入路径最多读一次布局，并把多行状态即时反映给页面。
        expect(scrollReads).toBeLessThanOrEqual(1);
        expect(mounted.result.isMultiLine.value).toBe(true);

        mounted.unmount();
    });

    it('user sees the saved draft, model chip and attachments restored into the editor', async () => {
        getModelSelectionMock().selectedModelId.value = 'model-1';
        getModelSelectionMock().selectedModelName.value = 'GPT-4.1';
        getModelSelectionMock().selectedProviderId.value = 7;
        const queryText = ref('hello world');
        const attachments = ref([createAttachment('file-1')]);

        const {
            result,
            emitQueryText,
            emitModelOverrideChange,
            emitRemoveAttachmentRequest,
            unmount,
        } = await mountSearchInput({
            queryText,
            attachments,
            modelOverride: ref({ modelId: 'model-1', providerId: 7 }),
        });

        result.initEditor();
        await flushAsyncWork();

        const editor = lastEditor();
        expect(editor.__text).toBe('hello world');
        expect(insertModelTagMock).toHaveBeenCalledWith(editor, {
            modelId: 'model-1',
            modelName: 'GPT-4.1',
            providerId: 7,
        });
        expect(insertAttachmentTagMock).toHaveBeenCalledWith(
            editor,
            {
                attachmentId: 'file-1',
                alias: 'A1-file-1',
                fileName: 'file-1.txt',
                fileType: 'file',
                preview: undefined,
                supportStatus: 'supported',
            },
            { textOffset: undefined, sameOffsetIndex: undefined }
        );
        // Restoring state must never look like the user typed or removed something.
        expect(emitQueryText).not.toHaveBeenCalled();
        expect(emitModelOverrideChange).not.toHaveBeenCalled();
        expect(emitRemoveAttachmentRequest).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets the model capabilities of the active model reported to the page', async () => {
        const { result, emitModelChange, unmount } = await mountSearchInput();

        result.initEditor();
        await flushAsyncWork();

        expect(emitModelChange).toHaveBeenCalledWith({
            supportsImages: true,
            supportsFiles: false,
        });

        unmount();
    });
});

describe('when the page replaces the draft behind the editor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        editorInstances.length = 0;
        modelSelectionState.current = {
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
        buildAttachmentPromptMetasMock.mockReturnValue([]);
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

    it('user sees the editor follow the page draft without it being treated as typing', async () => {
        const queryText = ref('initial');
        const { result, emitQueryText, unmount } = await mountSearchInput({ queryText });

        result.initEditor();
        await flushAsyncWork();
        vi.clearAllMocks();

        queryText.value = 'server sync';
        await flushAsyncWork();

        expect(lastEditor().__text).toBe('server sync');
        expect(emitQueryText).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets the typed text reported to the page', async () => {
        const { result, emitQueryText, unmount } = await mountSearchInput();

        result.initEditor();
        await flushAsyncWork();
        vi.clearAllMocks();

        simulateEditorUpdate('typed locally');

        expect(emitQueryText).toHaveBeenCalledWith('typed locally');
        expect(result.searchQuery.value).toBe('typed locally');

        unmount();
    });
});

describe('when the user removes a chip from the editor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        editorInstances.length = 0;
        modelSelectionState.current = {
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
        buildAttachmentPromptMetasMock.mockReturnValue([]);
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

    it('user gets the model override cleared and the attachment removal forwarded', async () => {
        const { result, emitModelOverrideChange, emitRemoveAttachmentRequest, unmount } =
            await mountSearchInput();

        result.initEditor();
        const extensionOptions = createSearchEditorExtensionsMock.mock.calls[0]?.[0] as
            | SearchEditorExtensionOptions
            | undefined;

        extensionOptions?.onTagRemoved?.('model-tag', 'ignored');
        extensionOptions?.onTagRemoved?.('attachment-tag', 'attachment-7');

        expect(emitModelOverrideChange).toHaveBeenCalledWith({
            modelId: null,
            providerId: null,
        });
        expect(emitRemoveAttachmentRequest).toHaveBeenCalledWith('attachment-7');

        unmount();
    });
});

describe('when the user recalls a previously sent prompt', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        editorInstances.length = 0;
        modelSelectionState.current = {
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
        buildAttachmentPromptMetasMock.mockImplementation((attachments: Array<{ id: string }>) =>
            attachments.map((attachment, index) => ({
                alias: `A${index + 1}-${attachment.id}`,
            }))
        );
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

    it('user gets the whole draft captured including the structured editor content', async () => {
        const attachments = ref([createAttachment('original')]);
        const { result, unmount } = await mountSearchInput({
            queryText: ref('initial'),
            attachments,
        });

        result.initEditor();
        const editor = lastEditor();
        editor.__text = 'captured text';
        editor.__json = { type: 'doc', text: 'captured text' };

        expect(result.captureInputHistorySnapshot()).toEqual(
            createInputHistorySnapshot({
                text: 'captured text',
                attachments: attachments.value,
                editorDoc: { type: 'doc', text: 'captured text' },
            })
        );

        unmount();
    });

    it('user still gets the recalled prompt restored as plain text when the structured restore fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { result, unmount } = await mountSearchInput({ queryText: ref('initial') });

        result.initEditor();
        const editor = lastEditor();

        setEditorJSONMock.mockImplementationOnce(() => {
            throw new Error('bad structured snapshot');
        });

        const restored = result.restoreInputHistorySnapshot(
            createInputHistorySnapshot({
                text: 'restored text',
                attachments: [createAttachment('restored', { draftInsertionOffset: 12 })],
                editorDoc: { type: 'doc', text: 'restored text' },
            })
        );
        await flushAsyncWork();

        expect(restored).toBe('restored text');
        expect(editor.__text).toBe('restored text');
        expect(insertAttachmentTagMock).toHaveBeenCalledWith(
            editor,
            {
                attachmentId: 'restored',
                alias: 'A1-restored',
                fileName: 'restored.txt',
                fileType: 'file',
                preview: undefined,
                supportStatus: 'supported',
            },
            { textOffset: 12, sameOffsetIndex: 0 }
        );
        // The caret must land at the end so the user can keep typing.
        expect(editor.commands.focus).toHaveBeenCalledWith('end');

        unmount();
    });
});

describe('when the user switches the application language', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        editorInstances.length = 0;
        modelSelectionState.current = {
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
        buildAttachmentPromptMetasMock.mockReturnValue([]);
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

    it('user sees the placeholder text translated into the new language', async () => {
        setLocale('zh-CN');
        const { result, unmount } = await mountSearchInput();

        result.initEditor();
        const extensionOptions = createSearchEditorExtensionsMock.mock.calls[0]?.[0] as
            | SearchEditorExtensionOptions
            | undefined;
        const placeholder =
            typeof extensionOptions?.placeholder === 'function'
                ? extensionOptions.placeholder
                : () => extensionOptions?.placeholder ?? '';

        expect(placeholder()).toBe('写下你的需求...');

        const placeholderElement = document.createElement('p');
        placeholderElement.setAttribute('data-placeholder', '写下你的需求...');
        lastEditor().view.dom.appendChild(placeholderElement);

        setLocale('en-US');
        await flushAsyncWork();

        expect(placeholder()).toBe('Write your request...');
        expect(placeholderElement.getAttribute('data-placeholder')).toBe('Write your request...');

        unmount();
    });
});

describe('when the user is selecting text in a long draft', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        editorInstances.length = 0;
        modelSelectionState.current = {
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
        buildAttachmentPromptMetasMock.mockReturnValue([]);
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

    it('user keeps the visible scroll position instead of being yanked around mid-selection', async () => {
        const editorHost = document.createElement('div');
        Object.defineProperty(editorHost, 'clientHeight', {
            configurable: true,
            value: 60,
        });
        editorHost.getBoundingClientRect = vi.fn(() => ({
            top: 0,
            bottom: 60,
            left: 0,
            right: 500,
            width: 500,
            height: 60,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        }));
        editorHost.scrollTop = 80;

        const { result, unmount } = await mountSearchInput({
            editorHostRef: ref(editorHost),
            queryText: ref('line one\nline two\nline three\nline four'),
        });

        result.initEditor();
        const editor = lastEditor();
        editor.view.coordsAtPos.mockReturnValue({ top: -120, bottom: -100 });
        editor.state.selection.empty = false;

        (editor.options.onSelectionUpdate as () => void)();

        expect(editorHost.scrollTop).toBe(80);

        unmount();
    });
});
