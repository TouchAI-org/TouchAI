import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { createInputHistorySnapshot } from '@/types/session';

import { mountComposable } from '../../../../../../tests/utils/composables';

type SearchEditorExtensionOptions = {
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
                $anchor: {
                    pos: 1,
                },
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

vi.mock('../tags', () => ({}));

vi.mock('@tiptap/vue-3', () => ({
    Editor: MockEditor,
}));

vi.mock('@/services/AgentService/infrastructure/attachments', () => ({
    buildAttachmentPromptMetas: buildAttachmentPromptMetasMock,
}));

vi.mock('../tags/attachment', () => ({
    ATTACHMENT_TAG_NODE: 'attachment-tag',
    getAttachmentTags: getAttachmentTagsMock,
    insertAttachmentTag: insertAttachmentTagMock,
    removeAttachmentTag: removeAttachmentTagMock,
    updateAttachmentTag: updateAttachmentTagMock,
}));

vi.mock('../tags/model', () => ({
    MODEL_TAG_NODE: 'model-tag',
    getModelTag: getModelTagMock,
    insertModelTag: insertModelTagMock,
    removeModelTag: removeModelTagMock,
}));

vi.mock('../utils/tiptap', () => ({
    createSearchEditorExtensions: createSearchEditorExtensionsMock,
    findSearchTagChip: findSearchTagChipMock,
    getEditorJSON: getEditorJSONMock,
    getEditorText: getEditorTextMock,
    handleEditorClick: handleEditorClickMock,
    isBlankEditorAreaTarget: isBlankEditorAreaTargetMock,
    isCursorAtDocEnd: isCursorAtDocEndMock,
    isCursorAtDocStart: isCursorAtDocStartMock,
    isCursorAtTextStart: isCursorAtTextStartMock,
    isSearchTagDomTarget: isSearchTagDomTargetMock,
    resolveMouseEventTarget: resolveMouseEventTargetMock,
    setEditorJSON: setEditorJSONMock,
    setEditorText: setEditorTextMock,
}));

vi.mock('./useDragging', () => ({
    useDragging: vi.fn(() => useDraggingMock),
}));

vi.mock('./useModelSelection', () => ({
    useModelSelection: vi.fn(() => modelSelectionState.current),
}));

import { useSearchInput } from './useSearchLogic';

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

describe('useSearchInput', () => {
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
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('initializes the editor with the controlled query, selected model, attachments, and model capabilities', async () => {
        getModelSelectionMock().selectedModelId.value = 'model-1';
        getModelSelectionMock().selectedModelName.value = 'GPT-4.1';
        getModelSelectionMock().selectedProviderId.value = 7;
        const queryText = ref('hello world');
        const attachments = ref([createAttachment('file-1')]);
        const emitQueryText = vi.fn();
        const emitModelChange = vi.fn();
        const emitModelOverrideChange = vi.fn();
        const emitRemoveAttachmentRequest = vi.fn();

        const mounted = await mountComposable(() =>
            useSearchInput({
                searchBarContainerRef: ref(null),
                editorHostRef: ref(document.createElement('div')),
                queryText,
                attachments,
                modelOverride: ref({
                    modelId: 'model-1',
                    providerId: 7,
                }),
                emitQueryText,
                emitModelChange,
                emitModelOverrideChange,
                emitRemoveAttachmentRequest,
                emitDragStart: vi.fn(),
                emitDragEnd: vi.fn(),
            })
        );

        mounted.result.initEditor();
        await flushAsyncWork();

        expect(emitModelChange).toHaveBeenCalledWith({
            supportsImages: true,
            supportsFiles: false,
        });
        expect(setEditorTextMock).toHaveBeenCalledWith(editorInstances[0], 'hello world');
        expect(insertModelTagMock).toHaveBeenCalledWith(editorInstances[0], {
            modelId: 'model-1',
            modelName: 'GPT-4.1',
            providerId: 7,
        });
        expect(insertAttachmentTagMock).toHaveBeenCalledWith(
            editorInstances[0],
            {
                attachmentId: 'file-1',
                alias: 'A1-file-1',
                fileName: 'file-1.txt',
                fileType: 'file',
                preview: undefined,
                supportStatus: 'supported',
            },
            {
                textOffset: undefined,
                sameOffsetIndex: undefined,
            }
        );
        expect(emitQueryText).not.toHaveBeenCalled();
        expect(emitModelOverrideChange).not.toHaveBeenCalled();
        expect(emitRemoveAttachmentRequest).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('updates the editor for controlled query changes without echoing them as user input, but emits real edits', async () => {
        const queryText = ref('initial');
        const emitQueryText = vi.fn();
        const mounted = await mountComposable(() =>
            useSearchInput({
                searchBarContainerRef: ref(null),
                editorHostRef: ref(document.createElement('div')),
                queryText,
                attachments: ref([]),
                modelOverride: ref({
                    modelId: null,
                    providerId: null,
                }),
                emitQueryText,
                emitModelChange: vi.fn(),
                emitModelOverrideChange: vi.fn(),
                emitRemoveAttachmentRequest: vi.fn(),
                emitDragStart: vi.fn(),
                emitDragEnd: vi.fn(),
            })
        );

        mounted.result.initEditor();
        await flushAsyncWork();
        vi.clearAllMocks();

        queryText.value = 'server sync';
        await flushAsyncWork();

        const editor = editorInstances[0]!;

        expect(setEditorTextMock).toHaveBeenCalledWith(editor, 'server sync');
        expect(emitQueryText).not.toHaveBeenCalled();

        editor.__text = 'typed locally';
        (editor.options.onUpdate as (payload: { editor: InstanceType<typeof MockEditor> }) => void)(
            {
                editor,
            }
        );

        expect(emitQueryText).toHaveBeenCalledWith('typed locally');
        expect(mounted.result.searchQuery.value).toBe('typed locally');

        mounted.unmount();
    });

    it('routes user tag removals to the outer model and attachment callbacks', async () => {
        const emitModelOverrideChange = vi.fn();
        const emitRemoveAttachmentRequest = vi.fn();
        const mounted = await mountComposable(() =>
            useSearchInput({
                searchBarContainerRef: ref(null),
                editorHostRef: ref(document.createElement('div')),
                queryText: ref(''),
                attachments: ref([]),
                modelOverride: ref({
                    modelId: null,
                    providerId: null,
                }),
                emitQueryText: vi.fn(),
                emitModelChange: vi.fn(),
                emitModelOverrideChange,
                emitRemoveAttachmentRequest,
                emitDragStart: vi.fn(),
                emitDragEnd: vi.fn(),
            })
        );

        mounted.result.initEditor();
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

        mounted.unmount();
    });

    it('captures editor snapshots and falls back to plain-text restore when structured restore fails', async () => {
        const attachments = ref([createAttachment('original')]);
        const mounted = await mountComposable(() =>
            useSearchInput({
                searchBarContainerRef: ref(null),
                editorHostRef: ref(document.createElement('div')),
                queryText: ref('initial'),
                attachments,
                modelOverride: ref({
                    modelId: null,
                    providerId: null,
                }),
                emitQueryText: vi.fn(),
                emitModelChange: vi.fn(),
                emitModelOverrideChange: vi.fn(),
                emitRemoveAttachmentRequest: vi.fn(),
                emitDragStart: vi.fn(),
                emitDragEnd: vi.fn(),
            })
        );

        mounted.result.initEditor();
        const editor = editorInstances[0]!;

        editor.__text = 'captured text';
        editor.__json = {
            type: 'doc',
            text: 'captured text',
        };

        expect(mounted.result.captureInputHistorySnapshot()).toEqual(
            createInputHistorySnapshot({
                text: 'captured text',
                attachments: attachments.value,
                editorDoc: {
                    type: 'doc',
                    text: 'captured text',
                },
            })
        );

        setEditorJSONMock.mockImplementationOnce(() => {
            throw new Error('bad structured snapshot');
        });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const restored = mounted.result.restoreInputHistorySnapshot(
            createInputHistorySnapshot({
                text: 'restored text',
                attachments: [createAttachment('restored', { draftInsertionOffset: 12 })],
                editorDoc: {
                    type: 'doc',
                    text: 'restored text',
                },
            })
        );
        await flushAsyncWork();

        expect(setEditorJSONMock).toHaveBeenCalled();
        expect(setEditorTextMock).toHaveBeenCalledWith(editor, 'restored text');
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
            {
                textOffset: 12,
                sameOffsetIndex: 0,
            }
        );
        expect(editor.commands.focus).toHaveBeenCalledWith('end');
        expect(restored).toBe('restored text');

        mounted.unmount();
    });
});
