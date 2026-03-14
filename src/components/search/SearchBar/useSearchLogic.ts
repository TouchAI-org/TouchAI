// 副作用导入：确保所有标签插件在编辑器创建前完成注册
import './tags';

import type { AttachmentSupportStatus } from '@services/AiService/attachments';
import { popupManager } from '@services/PopupService';
import { Editor } from '@tiptap/vue-3';
import { type Ref, ref, shallowRef, watch } from 'vue';

import {
    ATTACHMENT_TAG_NODE,
    type AttachmentTagAttrs,
    insertAttachmentTag,
    removeAttachmentTag,
    updateAttachmentTagsSupport,
} from './tags/attachment';
import { clearEditorPreservingModelTag, MODEL_TAG_NODE } from './tags/model';
import {
    clearEditor,
    createSearchEditorExtensions,
    findSearchTagChip,
    getEditorText,
    handleEditorClick,
    isBlankEditorAreaTarget,
    isCursorAtDocStart,
    isPlainText,
    isSearchTagDomTarget,
    resolveMouseEventTarget,
} from './tiptap';
import { useDragging } from './useDragging';
import { type ModelCapabilities, useModelSelection } from './useModelSelection';
import { useQuickShortcuts } from './useQuickShortcuts';

export type { ModelCapabilities } from './useModelSelection';

interface UseSearchInputOptions {
    quickSearchEnabled: Ref<boolean>;
    editorHostRef: Ref<HTMLElement | null>;
    emitSearch: (query: string) => void;
    emitModelChange: (capabilities: ModelCapabilities) => void;
    emitRemoveAttachment: (id: string, fromEditor?: boolean) => void;
    emitDragStart: () => void;
    emitDragEnd: () => void;
}

export interface UseSearchInputDeps {
    hidePopup: () => Promise<void>;
    createQuickShortcuts: typeof useQuickShortcuts;
    createModelSelection: typeof useModelSelection;
    createDragging: typeof useDragging;
}

const DEFAULT_DEPS: UseSearchInputDeps = {
    hidePopup: () => popupManager.hide(),
    createQuickShortcuts: useQuickShortcuts,
    createModelSelection: useModelSelection,
    createDragging: useDragging,
};

/**
 * 搜索输入编排层。
 * 负责聚合模型选择、快捷搜索、拖拽能力并对外输出统一交互接口。
 *
 * @param options 搜索输入依赖能力与事件回调。
 * @param deps 可注入外部副作用与子 composable 工厂。
 * @returns 搜索框状态、模型选择、快捷搜索和拖拽交互方法。
 */
export function useSearchInput(
    options: UseSearchInputOptions,
    deps: UseSearchInputDeps = DEFAULT_DEPS
) {
    const {
        quickSearchEnabled,
        editorHostRef,
        emitSearch,
        emitModelChange,
        emitRemoveAttachment,
        emitDragStart,
        emitDragEnd,
    } = options;

    // 1. 基础输入状态
    const searchQuery = ref('');
    const editor = shallowRef<Editor | null>(null);
    const logoContainerRef = ref<HTMLElement | null>(null);
    const isMultiLineState = ref(false);
    let cachedLineHeight = 0;

    // 2. 子能力组合
    // 顶层编排：快速搜索、模型选择、拖拽行为各自独立，组合在 search bar。
    const quickShortcuts = deps.createQuickShortcuts();
    const modelSelection = deps.createModelSelection({
        searchQuery,
        editor,
        logoContainerRef,
        closeQuickSearchPanel: quickShortcuts.closeQuickSearchPanel,
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
                if (tagName === MODEL_TAG_NODE) {
                    modelSelection.syncSelectedModelCleared();
                } else if (tagName === ATTACHMENT_TAG_NODE) {
                    emitRemoveAttachment(id, true);
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
                // 更新多行状态缓存
                isMultiLineState.value = computeIsMultiLine(updatedEditor as Editor);
                onInput();
                // 内容更新后滚动光标到可见区域
                scrollCursorIntoView();
            },
            onSelectionUpdate: () => {
                // 光标位置变化时滚动到可见区域（例如使用上下键移动光标）
                scrollCursorIntoView();
            },
        });

        editor.value = ed;
    }

    /**
     * 销毁编辑器实例，释放资源。
     */
    function destroyEditor() {
        editor.value?.destroy();
        editor.value = null;
        cachedLineHeight = 0;
    }

    // 4. 下拉态收敛
    /**
     * 判断任意下拉层是否处于打开状态。
     *
     * @returns 任一弹层打开时为 true。
     */
    function isAnyDropdownOpen() {
        return (
            modelSelection.isPopupOpen.value ||
            modelSelection.isModelDropdownOpen.value ||
            modelSelection.isSearchingModel.value ||
            quickShortcuts.isQuickSearchOpen.value
        );
    }

    /**
     * 统一关闭所有下拉层，常用于拖拽前收敛 UI。
     *
     * @returns Promise<void>
     */
    async function hideAllDropdowns() {
        if (!isAnyDropdownOpen()) {
            return;
        }

        try {
            await deps.hidePopup();
        } catch (error) {
            console.error('[SearchBar] Failed to hide dropdown popups before dragging:', error);
        } finally {
            // 始终回收 UI 状态，确保拖拽前界面一致。
            modelSelection.resetModelDropdownState();
            quickShortcuts.closeQuickSearchPanel();
        }
    }
    // 5. 状态同步监听
    // 模型能力变化时需要同时通知外层（emitModelChange）和同步编辑器内附件标签的
    // 支持状态（置灰/恢复），两者解耦在不同层级但由同一数据源驱动。
    watch(
        modelSelection.modelCapabilities,
        (capabilities) => {
            emitModelChange(capabilities);
            const ed = editor.value;
            if (ed) {
                updateAttachmentTagsSupport(ed, capabilities);
            }
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

    watch(
        searchQuery,
        (newQuery) => {
            // 快速搜索被禁用时，任何残留面板都应立即关闭。
            if (!quickSearchEnabled.value && quickShortcuts.isQuickSearchOpen.value) {
                quickShortcuts.closeQuickSearchPanel();
                return;
            }

            if (quickShortcuts.isQuickSearchOpen.value && !newQuery.trim()) {
                quickShortcuts.closeQuickSearchPanel();
            }
        },
        { flush: 'post' }
    );

    // 6. 输入与附件行为
    /**
     * 处理输入变更：模型搜索、快速搜索、普通搜索三种路径分流。
     *
     * @returns void
     */
    function onInput() {
        // 如果模型选择下拉框打开，输入内容用于搜索模型，不触发搜索事件
        if (modelSelection.isModelDropdownOpen.value) {
            modelSelection.updateDropdownSearchQuery(searchQuery.value);
            return;
        }

        // 关闭快速搜索能力时，退化为普通 search 事件透传。
        if (!quickSearchEnabled.value) {
            if (quickShortcuts.isQuickSearchOpen.value) {
                quickShortcuts.closeQuickSearchPanel();
            }
            emitSearch(searchQuery.value);
            return;
        }

        // 快速搜索：输入即触发（单行纯文本时自动触发搜索，多行或含标签时不触发）
        const query = searchQuery.value.trim();
        const plainText = editor.value ? isPlainText(editor.value) : true;
        if (!query || isMultiLine() || !plainText) {
            quickShortcuts.closeQuickSearchPanel();
        } else {
            quickShortcuts.triggerQuickSearch(searchQuery.value);
        }

        emitSearch(searchQuery.value);
    }

    // 6. 清空与附件行为
    /**
     * 清空输入并关闭快速搜索面板。
     *
     * @returns void
     */
    function clearInput(options?: { preserveModelTag?: boolean }) {
        const ed = editor.value;
        if (ed) {
            if (options?.preserveModelTag) {
                clearEditorPreservingModelTag(ed);
            } else {
                clearEditor(ed);
            }
        }
        searchQuery.value = '';
        // 清空输入时同步关闭快速搜索面板。
        quickShortcuts.closeQuickSearchPanel();
    }

    // 7. 输入焦点工具
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
     * 判断编辑器内容是否超过一行（返回缓存的状态）。
     */
    function isMultiLine(): boolean {
        return isMultiLineState.value;
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

    /**
     * 向编辑器中插入附件标签。
     * 根据当前模型能力自动计算 supportStatus，使新插入的标签
     * 在模型不支持该文件类型时立即呈现置灰状态。
     */
    function addAttachmentTag(attrs: AttachmentTagAttrs) {
        const ed = editor.value;
        if (!ed) return;
        // 从当前模型能力推断附件支持状态，避免插入后再触发一次额外的批量更新。
        const caps = modelSelection.modelCapabilities.value;
        let supportStatus: AttachmentSupportStatus = 'supported';
        if (attrs.fileType === 'image' && !caps.supportsImages) {
            supportStatus = 'unsupported-image';
        } else if (attrs.fileType === 'file' && !caps.supportsFiles) {
            supportStatus = 'unsupported-file';
        }
        insertAttachmentTag(ed, { ...attrs, supportStatus });
    }

    /**
     * 从编辑器中移除指定附件标签。
     */
    function removeAttachmentTagById(attachmentId: string) {
        const ed = editor.value;
        if (!ed) return;
        removeAttachmentTag(ed, attachmentId);
    }

    return {
        searchQuery,
        editor,
        logoContainerRef,
        quickSearchPanel: quickShortcuts.quickSearchPanel,
        selectedModelId: modelSelection.selectedModelId,
        selectedModelName: modelSelection.selectedModelName,
        selectedProviderId: modelSelection.selectedProviderId,
        activeModel: modelSelection.activeModel,
        isModelDropdownOpen: modelSelection.isModelDropdownOpen,
        isQuickSearchOpen: quickShortcuts.isQuickSearchOpen,
        isAnyDropdownOpen,
        toggleModelDropdown: modelSelection.toggleModelDropdown,
        closeModelDropdown: modelSelection.closeModelDropdown,
        hideAllDropdowns,
        openModelDropdown: modelSelection.openModelDropdown,
        clearSelectedModel: modelSelection.clearSelectedModel,
        openQuickSearchPanel: quickShortcuts.openQuickSearchPanel,
        closeQuickSearchPanel: quickShortcuts.closeQuickSearchPanel,
        moveQuickSearchSelection: quickShortcuts.moveQuickSearchSelection,
        getHighlightedQuickShortcut: quickShortcuts.getHighlightedQuickShortcut,
        openHighlightedQuickShortcut: quickShortcuts.openHighlightedQuickShortcut,
        clearInput,
        isCursorAtStart,
        isMultiLine: isMultiLineState,
        focus,
        loadActiveModel: modelSelection.loadActiveModel,
        handleContainerMouseDown: dragging.handleContainerMouseDown,
        handleEditorMouseDown,
        initEditor,
        destroyEditor,
        onEditorClick,
        addAttachmentTag,
        removeAttachmentTagById,
    };
}
