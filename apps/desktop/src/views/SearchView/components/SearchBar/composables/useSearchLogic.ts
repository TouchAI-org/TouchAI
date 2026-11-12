// 副作用导入：确保所有标签插件在编辑器创建前完成注册
import '../tags';

import { log } from '@services/ObservabilityService';
import { Editor } from '@tiptap/vue-3';
import { computed, type Ref, ref, shallowRef, watch } from 'vue';

import { locale, t } from '@/i18n';
import {
    buildAttachmentPromptMetas,
    type Index,
} from '@/services/AgentService/infrastructure/attachments';
import type { SelectedSkill } from '@/services/AgentService/skills';
import type { SearchActivationContext } from '@/services/SearchService';
import { recordAcceptedFileReference } from '@/services/SearchService/fileReferenceHistory';
import { createInputHistorySnapshot, type InputHistorySnapshot } from '@/types/session';

import {
    ATTACHMENT_TAG_NODE,
    type AttachmentTagAttrs,
    getAttachmentTags,
    insertAttachmentTag,
    removeAttachmentTag,
    updateAttachmentTag,
} from '../tags/attachment';
import { getModelTag, insertModelTag, MODEL_TAG_NODE, removeModelTag } from '../tags/model';
import { getSkillTags, insertSkillTag } from '../tags/skill';
import type { FilePickerContext, SearchModelOverride } from '../types';
import { handleAutocompleteKeyDown } from '../utils/autocomplete';
import { InlineCompletion, setInlineCompletion } from '../utils/inlineCompletion';
import {
    createSearchEditorExtensions,
    DEFAULT_PLACEHOLDER_KEY,
    findSearchTagChip,
    getEditorJSON,
    getEditorText,
    handleEditorClick,
    isBlankEditorAreaTarget,
    isCursorAtDocStart,
    isSearchTagDomTarget,
    resolveEditorCursorFlags,
    resolveMouseEventTarget,
    setEditorJSON,
    setEditorText,
} from '../utils/tiptap';
import { useDragging } from './useDragging';
import { containsFileQuery, useFileAutocomplete } from './useFileAutocomplete';
import { type ModelCapabilities, useModelSelection } from './useModelSelection';
import { containsSkillQuery, useSkillAutocomplete } from './useSkillAutocomplete';

export type { ModelCapabilities } from './useModelSelection';

interface UseSearchInputOptions {
    searchBarContainerRef: Ref<HTMLElement | null>;
    editorHostRef: Ref<HTMLElement | null>;
    queryText: Ref<string>;
    attachments: Ref<Index[]>;
    modelOverride: Ref<SearchModelOverride>;
    autoSelectFirst?: Readonly<Ref<boolean>>;
    completeFile?: Ref<((index?: number) => Index | null) | undefined>;
    moveFileSelection?: Ref<((direction: 'up' | 'down' | 'left' | 'right') => boolean) | undefined>;
    filePickerContext?: Readonly<Ref<FilePickerContext | null>>;
    emitQueryText: (query: string) => void;
    emitModelChange: (capabilities: ModelCapabilities) => void;
    emitModelOverrideChange: (modelOverride: SearchModelOverride) => void;
    emitRemoveAttachmentRequest: (id: string) => void;
    emitRestoreAttachmentRequest?: (attachment: Index) => void;
    emitDragStart: () => void;
    emitDragEnd: () => void;
    startDragging: (event: MouseEvent) => Promise<void>;
}

export interface UseSearchInputDeps {
    createModelSelection: typeof useModelSelection;
    createDragging: typeof useDragging;
    recordFileReference?: (path: string) => void;
}

const DEFAULT_DEPS: UseSearchInputDeps = {
    createModelSelection: useModelSelection,
    createDragging: useDragging,
    recordFileReference: recordAcceptedFileReference,
};

function createEmptyModelOverride(): SearchModelOverride {
    return {
        modelId: null,
        providerId: null,
    };
}

/**
 * 搜索输入编排层。
 * 负责聚合模型选择、编辑器与拖拽能力并对外输出统一交互接口。
 *
 * @param options 搜索输入依赖能力与事件回调。
 * @param deps 可注入外部副作用与子 composable 工厂。
 * @returns 搜索框状态、模型选择与拖拽交互方法。
 */
export function useSearchInput(
    options: UseSearchInputOptions,
    deps: UseSearchInputDeps = DEFAULT_DEPS
) {
    const {
        editorHostRef,
        searchBarContainerRef,
        queryText,
        attachments,
        modelOverride,
        emitQueryText,
        emitModelChange,
        emitModelOverrideChange,
        emitRemoveAttachmentRequest,
        emitDragStart,
        emitDragEnd,
    } = options;

    // 1. 基础输入状态
    const searchQuery = ref(queryText.value);
    const editor = shallowRef<Editor | null>(null);
    const logoContainerRef = ref<HTMLElement | null>(null);
    const isMultiLineState = ref(false);
    const cursorAtStart = ref(false);
    const cursorAtTextStart = ref(false);
    const cursorAtEnd = ref(false);
    const selectedSkills = ref<SelectedSkill[]>([]);
    const hasSkillQuery = ref(false);
    const fileInputActive = ref(false);
    const fileAutocomplete = useFileAutocomplete();
    const skillInputActive = computed(() => hasSkillQuery.value || selectedSkills.value.length > 0);
    let cachedLineHeight = 0;
    let isApplyingControlledQuery = false;
    let isRestoringInputHistory = false;
    let inputHistoryRestoreToken = 0;
    let controlledTagSyncDepth = 0;
    let consumedCompletionTab = false;
    // Match the editor's bounded undo history without putting file paths in nodes.
    const completedFileReferences = new Map<string, Index>();

    // 2. 子能力组合
    // 顶层编排：模型选择、拖拽行为各自独立，组合在 search bar。
    const modelSelection = deps.createModelSelection({
        searchBarContainerRef,
        logoContainerRef,
        modelOverride,
    });

    const dragging = deps.createDragging({
        editor,
        emitDragStart,
        emitDragEnd,
        startDragging: options.startDragging,
    });

    function getTextBeforeCursor(ed: Editor): string {
        const { $from } = ed.state.selection;
        return $from.parent.textBetween(0, $from.parentOffset, '\n', '\ufffc');
    }

    function insertSkillAtCursor(skill: SelectedSkill) {
        const ed = editor.value;
        if (!ed) {
            return;
        }

        insertSkillTag(ed, skill);
    }

    const skillAutocomplete = useSkillAutocomplete({
        autoSelectFirst: () => options.autoSelectFirst?.value ?? false,
        getSelectedSkills: () => {
            const ed = editor.value;
            return ed ? getSkillTags(ed) : [];
        },
        onSelect: (skill, trigger) => {
            const ed = editor.value;
            if (!ed) {
                return;
            }

            insertSkillTag(ed, skill, trigger.token, trigger.suffix);
        },
    });

    const fileCompletion = computed(() => {
        if (!options.completeFile?.value || skillAutocomplete.activeTrigger.value) return null;
        const completion = options.filePickerContext?.value?.completion;
        if (
            !completion ||
            completion.query !== (fileAutocomplete.query.value ?? queryText.value.trim()) ||
            (completion.implicit && !cursorAtEnd.value)
        )
            return null;
        return completion;
    });

    function handleEditorKeyDown(event: KeyboardEvent): boolean {
        const plainTab =
            event.key === 'Tab' &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            !event.isComposing &&
            event.keyCode !== 229;
        if (plainTab && event.repeat && consumedCompletionTab) return true;
        if (!event.repeat) consumedCompletionTab = false;
        if (skillAutocomplete.handleKeyDown(event)) {
            consumedCompletionTab = plainTab;
            return true;
        }
        if (
            fileAutocomplete.trigger.value &&
            handleAutocompleteKeyDown(event, {
                select: () => {
                    completeFileReference();
                },
                close: fileAutocomplete.close,
                move: (direction) => options.moveFileSelection?.value?.(direction) ?? false,
            })
        ) {
            consumedCompletionTab = plainTab;
            return true;
        }
        const ed = editor.value;
        if (!plainTab || !options.completeFile?.value || !ed?.isEditable) return false;
        consumedCompletionTab = true;
        if (event.repeat) return true;
        completeFileReference();
        return true;
    }

    function completeFileReference(resultIndex?: number): boolean {
        const ed = editor.value;
        if (!ed?.isEditable || ed.view.composing) return false;
        const trigger = fileAutocomplete.trigger.value;
        // Pointer acceptance must target the same live token as keyboard acceptance.
        if (fileInputActive.value && !trigger) return false;
        const attachment = options.completeFile?.value?.(
            resultIndex ?? fileCompletion.value?.index
        );
        if (attachment) {
            completedFileReferences.set(attachment.id, attachment);
            if (completedFileReferences.size > 100) {
                completedFileReferences.delete(completedFileReferences.keys().next().value!);
            }
            const index = attachments.value.findIndex((item) => item.id === attachment.id);
            const alias = buildAttachmentPromptMetas(attachments.value)[index]?.alias ?? '';
            insertAttachmentTag(ed, toAttachmentTagAttrs(attachment, alias), {
                atCurrentSelection: true,
                replaceToken: !trigger,
                replaceRange: trigger ? { from: trigger.from, to: trigger.to } : undefined,
                separateHistory: true,
            });
            deps.recordFileReference?.(attachment.originPath || attachment.path);
            fileAutocomplete.reset();
            return true;
        }
        return false;
    }

    watch(
        [editor, skillAutocomplete.completionText, fileCompletion],
        ([ed]) => {
            if (!ed || ed.isDestroyed) return;
            syncInlineCompletion(ed);
        },
        { flush: 'post' }
    );

    function syncInlineCompletion(ed: Editor) {
        if (
            setInlineCompletion(
                ed.view,
                skillAutocomplete.completionText.value || fileCompletion.value?.text || ''
            )
        )
            syncMultiLineState(ed);
    }

    function refreshAutocomplete(ed: Editor, resume = false) {
        if (ed.view.composing) return;
        if (!ed.isFocused || !ed.isEditable || !ed.state.selection.empty) {
            skillAutocomplete.close();
            fileAutocomplete.reset();
            syncInlineCompletion(ed);
            return;
        }
        const { $from } = ed.state.selection;
        const textAfterCursor = $from.parent.textBetween(
            $from.parentOffset,
            $from.parent.content.size,
            '\n',
            '\ufffc'
        );
        fileAutocomplete.refresh(getTextBeforeCursor(ed), textAfterCursor, ed.state.selection.from);
        if (fileAutocomplete.trigger.value) {
            skillAutocomplete.close();
            syncInlineCompletion(ed);
            return;
        }
        void skillAutocomplete.refresh(getTextBeforeCursor(ed), { resume, textAfterCursor });
        syncInlineCompletion(ed);
    }

    // 3. 编辑器创建
    /**
     * 将光标滚动到可见区域。
     * 当内容超过容器高度时，自动滚动使光标位置可见。
     */
    function scrollCursorIntoView() {
        const ed = editor.value;
        const host = editorHostRef.value;
        if (!ed || !host) return;
        if (!ed.state.selection.empty) return;

        requestAnimationFrame(() => {
            if (ed.isDestroyed || editor.value !== ed) return;
            const { view } = ed;
            if (!view.state.selection.empty) return;
            const coords = view.coordsAtPos(view.state.selection.$anchor.pos);
            if (!coords) return;

            const hostRect = host.getBoundingClientRect();
            const padding = 4;

            const cursorTop = coords.top - hostRect.top;
            const cursorBottom = coords.bottom - hostRect.top;
            const visibleTop = padding;
            const visibleBottom = host.clientHeight - padding;

            // 光标已在可见区域内，无需滚动
            if (cursorTop >= visibleTop && cursorBottom <= visibleBottom) {
                return;
            }

            // 计算需要的滚动调整量
            let scrollAdjustment = 0;
            if (cursorTop < visibleTop) {
                scrollAdjustment = cursorTop - visibleTop;
            } else if (cursorBottom > visibleBottom) {
                scrollAdjustment = cursorBottom - visibleBottom;
            }

            if (scrollAdjustment !== 0) {
                host.scrollTop = Math.max(0, host.scrollTop + scrollAdjustment);
            }
        });
    }

    /**
     * 初始化 Tiptap 编辑器实例。
     * 在组件 onMounted 后调用。EditorContent 组件会自动处理 DOM 挂载。
     */
    function initEditor() {
        const extensions = createSearchEditorExtensions({
            placeholder: () => t(DEFAULT_PLACEHOLDER_KEY),
            onTagRemoved: (tagName, id) => {
                if (controlledTagSyncDepth > 0) {
                    return;
                }

                if (tagName === MODEL_TAG_NODE) {
                    emitModelOverrideChange(createEmptyModelOverride());
                } else if (tagName === ATTACHMENT_TAG_NODE) {
                    emitRemoveAttachmentRequest(id);
                }
            },
        });

        const ed = new Editor({
            extensions: [...extensions, InlineCompletion],
            autofocus: false,
            onFocus: ({ editor: focusedEditor }) =>
                refreshAutocomplete(focusedEditor as Editor, true),
            editorProps: {
                attributes: {
                    class: 'tiptap',
                },
                handleKeyDown: (_view, event) => handleEditorKeyDown(event),
                handleDOMEvents: {
                    compositionend() {
                        queueMicrotask(() => {
                            const ed = editor.value;
                            if (ed && !ed.isDestroyed) refreshAutocomplete(ed);
                        });
                        return false;
                    },
                },
            },
            onUpdate: ({ editor: updatedEditor }) => {
                if (
                    !controlledTagSyncDepth &&
                    !isRestoringInputHistory &&
                    completedFileReferences.size
                ) {
                    for (const tag of getAttachmentTags(updatedEditor as Editor)) {
                        const attachment = completedFileReferences.get(tag.attachmentId);
                        if (
                            attachment &&
                            !attachments.value.some((item) => item.id === attachment.id)
                        ) {
                            options.emitRestoreAttachmentRequest?.(attachment);
                        }
                    }
                }
                const text = getEditorText(updatedEditor);
                searchQuery.value = text;
                syncEditorDerivedState(updatedEditor as Editor);
                onInput();
                refreshAutocomplete(updatedEditor as Editor);

                // 内容更新后滚动光标到可见区域
                scrollCursorIntoView();
            },
            onSelectionUpdate: () => {
                // 光标位置变化时滚动到可见区域（例如使用上下键移动光标）
                syncCursorFlags(editor.value);
                const ed = editor.value;
                if (ed) {
                    refreshAutocomplete(ed);
                }
                scrollCursorIntoView();
            },
        });

        editor.value = ed;
        syncEditorDerivedState(ed);
        syncControlledQueryToEditor(queryText.value);
        syncControlledModelOverrideToEditor();
        syncControlledAttachmentsToEditor();
    }

    /**
     * 销毁编辑器实例，释放资源。
     */
    function destroyEditor() {
        dragging.clearEditorSelectionDragState();
        completedFileReferences.clear();
        editor.value?.destroy();
        editor.value = null;
        skillAutocomplete.close();
        fileAutocomplete.reset();
        cachedLineHeight = 0;
    }

    function refreshPlaceholderLocale(ed: Editor, nextLocale: string) {
        ed.view.dispatch(ed.state.tr.setMeta('search-placeholder-locale', nextLocale));

        const placeholderText = t(DEFAULT_PLACEHOLDER_KEY);
        ed.view.dom.querySelectorAll<HTMLElement>('[data-placeholder]').forEach((element) => {
            element.setAttribute('data-placeholder', placeholderText);
        });
    }

    // 4. 状态同步监听
    // 模型能力是页面附件域的上游输入，SearchBar 只上报变化，
    // 附件 supportStatus 由页面 draft 统一决定，并受控同步到编辑器。
    watch(
        modelSelection.modelCapabilities,
        (capabilities) => {
            emitModelChange(capabilities);
        },
        { immediate: true }
    );

    /**
     * 统一刷新页面层需要的编辑器上下文事实，避免多个 watch 各自重复推导。
     *
     * @param ed 当前编辑器实例。
     * @returns void
     */
    function syncEditorDerivedState(ed: Editor) {
        selectedSkills.value = getSkillTags(ed);
        // Draft intent survives popup dismissal, selection changes, and window blur.
        const draftText = ed.state.doc.textBetween(0, ed.state.doc.content.size, '\n', '\ufffc');
        hasSkillQuery.value = containsSkillQuery(draftText);
        fileInputActive.value = containsFileQuery(draftText);
        syncMultiLineState(ed);
        syncCursorFlags(ed);
    }

    /** 一次性刷新光标位置派生状态（共享同一次文档查询）。 */
    function syncCursorFlags(ed: Editor | null) {
        if (!ed) {
            return;
        }

        const flags = resolveEditorCursorFlags(ed);
        cursorAtStart.value = flags.cursorAtStart;
        cursorAtTextStart.value = flags.cursorAtTextStart;
        cursorAtEnd.value = flags.cursorAtEnd;
    }

    /**
     * 同步多行状态。
     *
     * 自动换行需要读 `scrollHeight`/`lineHeight`（强制布局），
     * 但输入框的可视状态必须与本次输入同步，因此这里保持同步测量。
     */
    function syncMultiLineState(ed: Editor) {
        isMultiLineState.value = hasMultipleParagraphs(ed) || measureAutoWrappedLine(ed);
    }

    /**
     * 将受控 query 文本同步到编辑器。
     * 页面层持有普通 query 真相源；SearchBar 只在文本确实不一致时执行富文本同步，
     * 避免受控同步触发 onUpdate -> emit -> watch 循环。
     *
     * @param nextQuery 页面层期望显示的 query 文本。
     * @returns void
     */
    function syncControlledQueryToEditor(nextQuery: string) {
        searchQuery.value = nextQuery;

        const ed = editor.value;
        if (!ed) {
            return;
        }

        const currentText = getEditorText(ed);
        if (currentText === nextQuery) {
            syncEditorDerivedState(ed);
            return;
        }

        isApplyingControlledQuery = true;
        try {
            runControlledTagSync(() => {
                setEditorText(ed, nextQuery);
                syncControlledModelOverrideToEditor();
                syncControlledAttachmentsToEditor();
            });
        } finally {
            isApplyingControlledQuery = false;
        }

        syncEditorDerivedState(ed);
        refreshAutocomplete(ed);
    }

    watch(queryText, (nextQuery) => {
        if (isRestoringInputHistory) {
            searchQuery.value = nextQuery;
            return;
        }

        syncControlledQueryToEditor(nextQuery);
    });

    watch(
        locale,
        (nextLocale) => {
            const ed = editor.value;
            if (!ed) {
                return;
            }

            refreshPlaceholderLocale(ed, nextLocale);
        },
        { flush: 'post' }
    );

    /**
     * 受控标签同步包装器。
     * 页面 draft 同步到编辑器时会触发 NodeSync/onUpdate；这里通过深度计数屏蔽
     * 这类“受控同步”产生的移除事件，避免它们再次被误判成用户手动删除。
     */
    function runControlledTagSync(effect: () => void) {
        controlledTagSyncDepth += 1;
        try {
            effect();
        } finally {
            controlledTagSyncDepth -= 1;
        }
    }

    function isSameModelTag(
        current: ReturnType<typeof getModelTag>,
        next: {
            modelId: string;
            modelName: string;
            providerId: number | null;
        }
    ) {
        return (
            current?.modelId === next.modelId &&
            current?.modelName === next.modelName &&
            current?.providerId === next.providerId
        );
    }

    /**
     * 将页面层受控的模型覆盖状态投影到编辑器标签。
     */
    function syncControlledModelOverrideToEditor() {
        const ed = editor.value;
        if (!ed) {
            return;
        }

        const currentTag = getModelTag(ed);
        const selectedModelId = modelSelection.selectedModelId.value;
        const selectedProviderId = modelSelection.selectedProviderId.value;
        if (!selectedModelId || selectedProviderId === null) {
            if (currentTag) {
                runControlledTagSync(() => removeModelTag(ed));
            }
            return;
        }

        const modelName = modelSelection.selectedModelName.value;
        if (!modelName) {
            if (currentTag && currentTag.modelId !== selectedModelId) {
                runControlledTagSync(() => removeModelTag(ed));
            }
            return;
        }

        const nextTag = {
            modelId: selectedModelId,
            modelName,
            providerId: selectedProviderId,
        };

        if (isSameModelTag(currentTag, nextTag)) {
            return;
        }

        runControlledTagSync(() => insertModelTag(ed, nextTag));
    }

    function toAttachmentTagAttrs(attachment: Index, alias: string): AttachmentTagAttrs {
        return {
            attachmentId: attachment.id,
            alias,
            fileName: attachment.name,
            fileType: attachment.type,
            preview: attachment.preview,
            supportStatus: attachment.supportStatus,
        };
    }

    function isSameAttachmentTag(current: AttachmentTagAttrs, next: AttachmentTagAttrs) {
        return (
            current.attachmentId === next.attachmentId &&
            current.alias === next.alias &&
            current.fileName === next.fileName &&
            current.fileType === next.fileType &&
            current.preview === next.preview &&
            current.supportStatus === next.supportStatus
        );
    }

    /**
     * 将页面受控附件列表 diff 后同步到编辑器。
     * 这里故意使用“增删改”而不是整份重建文档，避免用户正在输入时丢失光标、
     * 也避免误改模型标签或正文段落结构。
     */
    function syncAttachmentsToEditor(ed: Editor, nextAttachments: Index[]) {
        const currentTags = getAttachmentTags(ed);
        const currentById = new Map<string, AttachmentTagAttrs>(
            currentTags.map((tag) => [tag.attachmentId, tag])
        );
        const metas = buildAttachmentPromptMetas(nextAttachments);
        const nextTags = nextAttachments.map((attachment, index) =>
            toAttachmentTagAttrs(attachment, metas[index]!.alias)
        );
        const nextById = new Map<string, AttachmentTagAttrs>(
            nextTags.map((tag) => [tag.attachmentId, tag])
        );

        for (const currentTag of currentTags) {
            if (!nextById.has(currentTag.attachmentId)) {
                runControlledTagSync(() => removeAttachmentTag(ed, currentTag.attachmentId));
            }
        }

        // mixed payload 中多张图片可能落在同一文本 offset，用计数保持原相对顺序。
        const sameOffsetInsertionCounts = new Map<number, number>();
        for (const [index, nextTag] of nextTags.entries()) {
            const currentTag = currentById.get(nextTag.attachmentId);
            if (!currentTag) {
                const draftInsertionOffset = nextAttachments[index]?.draftInsertionOffset;
                const sameOffsetIndex =
                    typeof draftInsertionOffset === 'number'
                        ? (sameOffsetInsertionCounts.get(draftInsertionOffset) ?? 0)
                        : undefined;
                runControlledTagSync(() =>
                    insertAttachmentTag(ed, nextTag, {
                        textOffset: draftInsertionOffset,
                        sameOffsetIndex,
                    })
                );
                if (typeof draftInsertionOffset === 'number') {
                    sameOffsetInsertionCounts.set(draftInsertionOffset, sameOffsetIndex! + 1);
                }
                continue;
            }

            if (!isSameAttachmentTag(currentTag, nextTag)) {
                runControlledTagSync(() => updateAttachmentTag(ed, nextTag));
            }
        }
    }

    function syncControlledAttachmentsToEditor() {
        const ed = editor.value;
        if (!ed) {
            return;
        }

        syncAttachmentsToEditor(ed, attachments.value);
    }

    function captureInputHistorySnapshot(): InputHistorySnapshot {
        const ed = editor.value;
        return createInputHistorySnapshot({
            text: ed ? getEditorText(ed) : queryText.value,
            attachments: attachments.value,
            skills: ed ? getSkillTags(ed) : [],
            editorDoc: ed ? getEditorJSON(ed) : undefined,
        });
    }

    function captureSearchActivationInput(): NonNullable<SearchActivationContext['input']> {
        const ed = editor.value;
        const selection = ed?.state.selection;
        const text =
            ed && selection && !selection.empty
                ? ed.state.doc.textBetween(selection.from, selection.to, '\n', '')
                : '';
        return {
            ...(text ? { text } : {}),
            files: attachments.value.map((file) => ({
                id: file.id,
                name: file.name,
                kind: file.type,
            })),
        };
    }

    function restoreSkillTagsWhenSnapshotHasNoDoc(ed: Editor, snapshot: InputHistorySnapshot) {
        if (snapshot.editorDoc || !snapshot.skills?.length) {
            return;
        }

        for (const skill of snapshot.skills) {
            insertSkillTag(ed, skill);
        }
    }

    function restoreInputHistorySnapshot(snapshot: InputHistorySnapshot): string {
        const normalizedSnapshot = createInputHistorySnapshot(snapshot);
        const ed = editor.value;
        if (!ed) {
            return normalizedSnapshot.text;
        }

        searchQuery.value = normalizedSnapshot.text;
        const restoreToken = ++inputHistoryRestoreToken;
        isRestoringInputHistory = true;
        isApplyingControlledQuery = true;
        try {
            runControlledTagSync(() => {
                if (normalizedSnapshot.editorDoc) {
                    setEditorJSON(ed, normalizedSnapshot.editorDoc);
                } else {
                    setEditorText(ed, normalizedSnapshot.text);
                }
                syncControlledModelOverrideToEditor();
                syncAttachmentsToEditor(ed, normalizedSnapshot.attachments);
                restoreSkillTagsWhenSnapshotHasNoDoc(ed, normalizedSnapshot);
            });
        } catch (error) {
            log.error(
                '[SearchBar] Failed to restore editor snapshot, fallback to plain text:',
                error
            );
            runControlledTagSync(() => {
                setEditorText(ed, normalizedSnapshot.text);
                syncControlledModelOverrideToEditor();
                syncAttachmentsToEditor(ed, normalizedSnapshot.attachments);
                for (const skill of normalizedSnapshot.skills ?? []) {
                    insertSkillTag(ed, skill);
                }
            });
        } finally {
            isApplyingControlledQuery = false;
        }

        const restoredText = getEditorText(ed);
        searchQuery.value = restoredText;
        ed.commands.focus('end');
        syncEditorDerivedState(ed);
        scrollCursorIntoView();
        refreshAutocomplete(ed);
        queueMicrotask(() => {
            if (inputHistoryRestoreToken === restoreToken) {
                isRestoringInputHistory = false;
            }
        });
        return restoredText;
    }

    watch(
        () => [
            modelSelection.selectedModelId.value,
            modelSelection.selectedProviderId.value,
            modelSelection.selectedModelName.value,
        ],
        () => {
            syncControlledModelOverrideToEditor();
        },
        { immediate: true, flush: 'post' }
    );

    watch(
        () => ({
            attachments: attachments.value.map((attachment) => ({
                id: attachment.id,
                name: attachment.name,
                type: attachment.type,
                preview: attachment.preview ?? null,
                supportStatus: attachment.supportStatus,
                draftInsertionOffset: attachment.draftInsertionOffset ?? null,
            })),
        }),
        () => {
            if (isRestoringInputHistory) {
                return;
            }

            syncControlledAttachmentsToEditor();
        },
        { immediate: true, flush: 'post', deep: true }
    );

    // 5. 输入与附件行为
    /**
     * 处理输入变更：仅同步普通草稿文本。
     *
     * @returns void
     */
    function onInput() {
        if (!isApplyingControlledQuery && searchQuery.value !== queryText.value) {
            emitQueryText(searchQuery.value);
        }
    }

    // 6. 输入焦点工具
    /**
     * 判断光标是否位于模型标签后的正文起点。
     *
     * @returns 光标位于正文起点时为 true。
     */
    function isCursorAtStart(): boolean {
        const ed = editor.value;
        if (!ed) return false;
        return isCursorAtDocStart(ed);
    }

    /**
     * 计算编辑器内容是否超过一行。
     * 通过检查文档中的段落节点数量来判断：
     * - 多个段落节点（包括空行）= 多行
     * - 单个段落但内容自动换行 = 多行
     */
    function hasMultipleParagraphs(ed: Editor): boolean {
        let paragraphCount = 0;
        ed.state.doc.descendants((node) => {
            if (node.type.name === 'paragraph') {
                paragraphCount += 1;
            }
            return paragraphCount <= 1; // 找到第二个段落就停止遍历
        });

        return paragraphCount > 1;
    }

    /** 单个段落时，通过布局测量判断是否自动换行（强制布局，需按帧合并）。 */
    function measureAutoWrappedLine(ed: Editor): boolean {
        if (!cachedLineHeight) {
            cachedLineHeight = parseFloat(getComputedStyle(ed.view.dom).lineHeight) || 0;
        }
        if (!cachedLineHeight) return false;
        return ed.view.dom.scrollHeight > cachedLineHeight * 1.5;
    }

    /**
     * 将焦点置于搜索编辑器。
     *
     * @returns Promise<void>
     */
    async function focus() {
        const ed = editor.value;
        if (!ed) return;

        // The surface lifecycle owns focus. Tiptap's command defers it to RAF,
        // which can steal focus from an overlay opened before that frame runs.
        ed.view.focus();
    }

    /**
     * 编辑器 mousedown 预处理：标签元素上 preventDefault 阻止浏览器默认选区，
     * 其余区域转发给拖拽模块判断是否启动窗口拖拽。
     */
    function handleEditorMouseDown(event: MouseEvent): boolean {
        const target = resolveMouseEventTarget(event);

        if (target && isSearchTagDomTarget(target)) {
            event.preventDefault();
            return false;
        }

        return dragging.handleEditorMouseDown(event);
    }

    /**
     * 处理编辑器内的点击事件。
     * 职责链：拖拽吞噬 → 标签交互 → 空白区域聚焦 → 段落内光标定位。
     * 使用 caretPositionFromPoint/caretRangeFromPoint 精确定位点击在段落末尾
     * 之后的空白区域，此时将光标移至编辑器末尾。
     */
    function onEditorClick(event: MouseEvent) {
        const ed = editor.value;
        if (!ed) return;

        if (dragging.consumeEditorClickAfterDrag()) {
            return;
        }

        handleEditorClick(ed, event);

        const target = resolveMouseEventTarget(event);

        if (!target || event.target instanceof Text) return;
        if (findSearchTagChip(target) || isSearchTagDomTarget(target)) {
            return;
        }

        // Only the outer host is blank here; clicks inside ProseMirror already
        // carry the browser's caret or range and must not reset it to the end.
        if (isBlankEditorAreaTarget(target) && !ed.view.dom.contains(target)) {
            ed.commands.focus('end');
            return;
        }

        if (target.tagName !== 'P') {
            return;
        }

        const ownerDocument = target.ownerDocument as Document & {
            caretPositionFromPoint?: (
                x: number,
                y: number
            ) => { offsetNode: Node; offset: number } | null;
            caretRangeFromPoint?: (x: number, y: number) => Range | null;
        };

        let offsetNode: Node | null = null;
        let offset = 0;

        if (ownerDocument.caretPositionFromPoint) {
            const caretPosition = ownerDocument.caretPositionFromPoint(
                event.clientX,
                event.clientY
            );
            offsetNode = caretPosition?.offsetNode ?? null;
            offset = caretPosition?.offset ?? 0;
        } else if (ownerDocument.caretRangeFromPoint) {
            const caretRange = ownerDocument.caretRangeFromPoint(event.clientX, event.clientY);
            offsetNode = caretRange?.startContainer ?? null;
            offset = caretRange?.startOffset ?? 0;
        }

        if (offsetNode instanceof Text) {
            return;
        }

        if (offsetNode === target && offset >= target.childNodes.length) {
            ed.commands.focus('end');
        }
    }

    return {
        searchQuery,
        editor,
        logoContainerRef,
        selectedModelId: modelSelection.selectedModelId,
        selectedModelName: modelSelection.selectedModelName,
        selectedModel: modelSelection.selectedModel,
        selectedProviderId: modelSelection.selectedProviderId,
        activeModel: modelSelection.activeModel,
        prefetchModelDropdownData: modelSelection.loadDropdownModels,
        invalidateModelDropdownData: modelSelection.invalidateDropdownModels,
        prepareModelDropdownOpen: modelSelection.prepareModelDropdownOpen,
        selectModelFromDropdown: modelSelection.handleModelSelect,
        getModelDropdownAnchor: modelSelection.getModelDropdownAnchor,
        getModelDropdownContext: modelSelection.getModelDropdownContext,
        isCursorAtStart,
        isMultiLine: isMultiLineState,
        cursorAtStart,
        cursorAtTextStart,
        cursorAtEnd,
        focus,
        insertSkillAtCursor,
        loadActiveModel: modelSelection.loadActiveModel,
        skillAutocomplete,
        fileAutocomplete,
        fileInputActive,
        completeFileReference,
        skillInputActive,
        selectedSkills,
        handleContainerMouseDown: dragging.handleContainerMouseDown,
        handleEditorMouseDown,
        initEditor,
        destroyEditor,
        onEditorClick,
        clearDraggingState: dragging.clearEditorSelectionDragState,
        captureInputHistorySnapshot,
        captureSearchActivationInput,
        restoreInputHistorySnapshot,
    };
}
