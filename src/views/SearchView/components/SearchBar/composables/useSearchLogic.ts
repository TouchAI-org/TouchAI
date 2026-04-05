// 副作用导入：确保所有标签插件在编辑器创建前完成注册
import '../tags';

import { Editor } from '@tiptap/vue-3';
import { type Ref, ref, shallowRef, watch } from 'vue';

import type { Index } from '@/services/AgentService/infrastructure/attachments';

import {
    ATTACHMENT_TAG_NODE,
    type AttachmentTagAttrs,
    getAttachmentTags,
    insertAttachmentTag,
    removeAttachmentTag,
    updateAttachmentTag,
} from '../tags/attachment';
import { getModelTag, insertModelTag, MODEL_TAG_NODE, removeModelTag } from '../tags/model';
import type { SearchModelOverride } from '../types';
import {
    createSearchEditorExtensions,
    findSearchTagChip,
    getEditorText,
    handleEditorClick,
    isBlankEditorAreaTarget,
    isCursorAtDocStart,
    isSearchTagDomTarget,
    resolveMouseEventTarget,
    setEditorText,
} from '../utils/tiptap';
import { useDragging } from './useDragging';
import { type ModelCapabilities, useModelSelection } from './useModelSelection';

export type { ModelCapabilities } from './useModelSelection';

interface UseSearchInputOptions {
    editorHostRef: Ref<HTMLElement | null>;
    queryText: Ref<string>;
    attachments: Ref<Index[]>;
    modelOverride: Ref<SearchModelOverride>;
    emitQueryText: (query: string) => void;
    emitModelChange: (capabilities: ModelCapabilities) => void;
    emitModelOverrideChange: (modelOverride: SearchModelOverride) => void;
    emitRemoveAttachmentRequest: (id: string) => void;
    emitDragStart: () => void;
    emitDragEnd: () => void;
}

export interface UseSearchInputDeps {
    createModelSelection: typeof useModelSelection;
    createDragging: typeof useDragging;
}

const DEFAULT_DEPS: UseSearchInputDeps = {
    createModelSelection: useModelSelection,
    createDragging: useDragging,
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
    let cachedLineHeight = 0;
    let isApplyingControlledQuery = false;
    let controlledTagSyncDepth = 0;

    // 2. 子能力组合
    // 顶层编排：模型选择、拖拽行为各自独立，组合在 search bar。
    const modelSelection = deps.createModelSelection({
        searchQuery,
        editor,
        logoContainerRef,
        modelOverride,
    });

    const dragging = deps.createDragging({
        editor,
        emitDragStart,
        emitDragEnd,
    });

    // 3. 编辑器创建
    /**
     * 将光标滚动到可见区域。
     * 当内容超过容器高度时，自动滚动使光标位置可见。
     */
    function scrollCursorIntoView() {
        const ed = editor.value;
        const host = editorHostRef.value;
        if (!ed || !host) return;

        requestAnimationFrame(() => {
            const { view } = ed;
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
            placeholder: modelSelection.currentPlaceholder.value,
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
            extensions,
            autofocus: true,
            editorProps: {
                attributes: {
                    class: 'tiptap',
                },
            },
            onUpdate: ({ editor: updatedEditor }) => {
                const text = getEditorText(updatedEditor);
                searchQuery.value = text;
                syncEditorDerivedState(updatedEditor as Editor);
                onInput();

                // 内容更新后滚动光标到可见区域
                scrollCursorIntoView();
            },
            onSelectionUpdate: () => {
                // 光标位置变化时滚动到可见区域（例如使用上下键移动光标）
                cursorAtStart.value = isCursorAtStart();
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
        editor.value?.destroy();
        editor.value = null;
        cachedLineHeight = 0;
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

    // 监听 placeholder 变化，动态更新编辑器
    watch(modelSelection.currentPlaceholder, (newPlaceholder) => {
        const ed = editor.value;
        if (!ed) return;
        // Tiptap Placeholder 扩展不支持运行时更新，通过 DOM 属性同步
        const firstParagraph = ed.view.dom.querySelector('p.is-editor-empty');
        if (firstParagraph) {
            firstParagraph.setAttribute('data-placeholder', newPlaceholder);
        }
    });

    /**
     * 统一刷新页面层需要的编辑器上下文事实，避免多个 watch 各自重复推导。
     *
     * @param ed 当前编辑器实例。
     * @returns void
     */
    function syncEditorDerivedState(ed: Editor) {
        isMultiLineState.value = computeIsMultiLine(ed);
        cursorAtStart.value = isCursorAtStart();
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

        if (modelSelection.isModelDropdownOpen.value) {
            return;
        }

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
    }

    watch(queryText, (nextQuery) => {
        syncControlledQueryToEditor(nextQuery);
    });

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
     * 模型搜索会话打开时会暂时清空编辑器承载搜索输入，此时禁止回写标签，
     * 等会话关闭并恢复草稿后再同步，避免把 dropdown 查询框污染成正文内容。
     */
    function syncControlledModelOverrideToEditor() {
        const ed = editor.value;
        if (!ed || modelSelection.isModelDropdownOpen.value) {
            return;
        }

        const currentTag = getModelTag(ed);
        if (!modelOverride.value.modelId) {
            if (currentTag) {
                runControlledTagSync(() => removeModelTag(ed));
            }
            return;
        }

        const modelName = modelSelection.selectedModelName.value;
        if (!modelName) {
            if (currentTag && currentTag.modelId !== modelOverride.value.modelId) {
                runControlledTagSync(() => removeModelTag(ed));
            }
            return;
        }

        const nextTag = {
            modelId: modelOverride.value.modelId,
            modelName,
            providerId: modelOverride.value.providerId,
        };

        if (isSameModelTag(currentTag, nextTag)) {
            return;
        }

        runControlledTagSync(() => insertModelTag(ed, nextTag));
    }

    function toAttachmentTagAttrs(attachment: Index): AttachmentTagAttrs {
        return {
            attachmentId: attachment.id,
            fileName: attachment.name,
            fileType: attachment.type,
            preview: attachment.preview,
            supportStatus: attachment.supportStatus,
        };
    }

    function isSameAttachmentTag(current: AttachmentTagAttrs, next: AttachmentTagAttrs) {
        return (
            current.attachmentId === next.attachmentId &&
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
    function syncControlledAttachmentsToEditor() {
        const ed = editor.value;
        if (!ed || modelSelection.isModelDropdownOpen.value) {
            return;
        }

        const currentTags = getAttachmentTags(ed);
        const currentById = new Map<string, AttachmentTagAttrs>(
            currentTags.map((tag) => [tag.attachmentId, tag])
        );
        const nextTags = attachments.value.map(toAttachmentTagAttrs);
        const nextById = new Map<string, AttachmentTagAttrs>(
            nextTags.map((tag) => [tag.attachmentId, tag])
        );

        for (const currentTag of currentTags) {
            if (!nextById.has(currentTag.attachmentId)) {
                runControlledTagSync(() => removeAttachmentTag(ed, currentTag.attachmentId));
            }
        }

        for (const nextTag of nextTags) {
            const currentTag = currentById.get(nextTag.attachmentId);
            if (!currentTag) {
                runControlledTagSync(() => insertAttachmentTag(ed, nextTag));
                continue;
            }

            if (!isSameAttachmentTag(currentTag, nextTag)) {
                runControlledTagSync(() => updateAttachmentTag(ed, nextTag));
            }
        }
    }

    watch(
        () => [
            modelOverride.value.modelId,
            modelOverride.value.providerId,
            modelSelection.selectedModelName.value,
            modelSelection.isModelDropdownOpen.value,
        ],
        () => {
            syncControlledModelOverrideToEditor();
        },
        { immediate: true, flush: 'post' }
    );

    watch(
        () => ({
            isModelDropdownOpen: modelSelection.isModelDropdownOpen.value,
            attachments: attachments.value.map((attachment) => ({
                id: attachment.id,
                name: attachment.name,
                type: attachment.type,
                preview: attachment.preview ?? null,
                supportStatus: attachment.supportStatus,
            })),
        }),
        () => {
            syncControlledAttachmentsToEditor();
        },
        { immediate: true, flush: 'post', deep: true }
    );

    // 5. 输入与附件行为
    /**
     * 处理输入变更：普通输入同步到页面草稿；模型搜索模式则只刷新 dropdown 查询。
     *
     * @returns void
     */
    function onInput() {
        if (modelSelection.isModelDropdownOpen.value) {
            modelSelection.updateDropdownSearchQuery(searchQuery.value);
            return;
        }

        if (!isApplyingControlledQuery && searchQuery.value !== queryText.value) {
            emitQueryText(searchQuery.value);
        }
    }

    // 6. 输入焦点工具
    /**
     * 判断光标是否位于编辑器起始位置。
     *
     * @returns 光标位于起始位置时为 true。
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
    function computeIsMultiLine(ed: Editor): boolean {
        if (!ed) return false;

        // 检查文档中是否有多个段落节点（包括空行）
        const { doc } = ed.state;
        let paragraphCount = 0;
        doc.descendants((node) => {
            if (node.type.name === 'paragraph') {
                paragraphCount++;
            }
            return paragraphCount <= 1; // 找到第二个段落就停止遍历
        });

        // 如果有多个段落，说明有换行（包括空行）
        if (paragraphCount > 1) {
            return true;
        }

        // 如果只有一个段落，检查是否因为内容过长而自动换行
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

        ed.commands.focus();
    }

    /**
     * 编辑器 mousedown 预处理：标签元素上 preventDefault 阻止浏览器默认选区，
     * 其余区域转发给拖拽模块判断是否启动窗口拖拽。
     */
    function handleEditorMouseDown(event: MouseEvent) {
        const target = resolveMouseEventTarget(event);

        if (target && isSearchTagDomTarget(target)) {
            event.preventDefault();
            return;
        }

        dragging.handleEditorMouseDown(event);
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

        if (isBlankEditorAreaTarget(target)) {
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
        isModelDropdownOpen: modelSelection.isModelDropdownOpen,
        modelDropdownSearchQuery: modelSelection.dropdownSearchQuery,
        prefetchModelDropdownData: modelSelection.loadPopupModels,
        invalidateModelDropdownData: modelSelection.invalidatePopupModels,
        prepareModelDropdownOpen: modelSelection.prepareModelDropdownOpen,
        resetModelDropdownState: modelSelection.resetModelDropdownState,
        selectModelFromDropdown: modelSelection.handleModelSelect,
        getModelDropdownAnchor: modelSelection.getModelDropdownAnchor,
        getModelDropdownContext: modelSelection.getModelDropdownContext,
        isCursorAtStart,
        isMultiLine: isMultiLineState,
        cursorAtStart,
        focus,
        loadActiveModel: modelSelection.loadActiveModel,
        handleContainerMouseDown: dragging.handleContainerMouseDown,
        handleEditorMouseDown,
        initEditor,
        destroyEditor,
        onEditorClick,
        clearDraggingState: dragging.clearEditorSelectionDragState,
    };
}
