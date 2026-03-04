import type { Index } from '@services/AiService/attachments';
import { native } from '@services/NativeService';
import { popupManager } from '@services/PopupService';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { type Ref, ref, watch } from 'vue';

import { useDragging } from './useDragging';
import { type ModelCapabilities, useModelSelection } from './useModelSelection';
import { useQuickShortcuts } from './useQuickShortcuts';

export type { ModelCapabilities } from './useModelSelection';

interface UseSearchInputOptions {
    quickSearchEnabled: Ref<boolean>;
    emitSearch: (query: string) => void;
    emitModelChange: (capabilities: ModelCapabilities) => void;
    emitRemoveAttachment: (id: string) => void;
    emitDragStart: () => void;
    emitDragEnd: () => void;
}

export interface UseSearchInputDeps {
    hidePopup: () => Promise<void>;
    hideSearchWindow: () => Promise<void>;
    openPath: typeof openPath;
    revealItemInDir: typeof revealItemInDir;
    createQuickShortcuts: typeof useQuickShortcuts;
    createModelSelection: typeof useModelSelection;
    createDragging: typeof useDragging;
}

const DEFAULT_DEPS: UseSearchInputDeps = {
    hidePopup: () => popupManager.hide(),
    hideSearchWindow: () => native.window.hideSearchWindow(),
    openPath,
    revealItemInDir,
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
        emitSearch,
        emitModelChange,
        emitRemoveAttachment,
        emitDragStart,
        emitDragEnd,
    } = options;

    // 1. 基础输入状态
    const searchQuery = ref('');
    const searchInput = ref<HTMLInputElement | null>(null);
    const logoContainerRef = ref<HTMLElement | null>(null);

    // 2. 子能力组合
    // 顶层编排：快速搜索、模型选择、拖拽行为各自独立，组合在 search bar。
    const quickShortcuts = deps.createQuickShortcuts();
    const modelSelection = deps.createModelSelection({
        searchQuery,
        searchInput,
        logoContainerRef,
        closeQuickSearchPanel: quickShortcuts.closeQuickSearchPanel,
    });
    const dragging = deps.createDragging({
        searchInput,
        emitDragStart,
        emitDragEnd,
    });

    // 3. 下拉态收敛
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
    // 4. 状态同步监听
    watch(
        modelSelection.modelCapabilities,
        (capabilities) => {
            emitModelChange(capabilities);
        },
        { immediate: true }
    );

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

    // 5. 输入与附件行为
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

        // 快速搜索
        const query = searchQuery.value.trim();
        if (!query) {
            quickShortcuts.closeQuickSearchPanel();
        } else if (quickShortcuts.isQuickSearchOpen.value) {
            // 仅在面板已打开时更新搜索，避免输入时自动打开面板。
            quickShortcuts.triggerQuickSearch(searchQuery.value);
        }

        emitSearch(searchQuery.value);
    }

    /**
     * 请求删除指定附件。
     *
     * @param id 附件唯一标识。
     * @returns void
     */
    function removeAttachment(id: string) {
        emitRemoveAttachment(id);
    }

    /**
     * 预览附件：图片直接打开，其他文件在目录中定位。
     *
     * @param attachment 待预览附件信息。
     * @returns Promise<void>
     */
    async function previewAttachment(attachment: Index) {
        try {
            await deps.hideSearchWindow();
            // 图片直接打开，其他文件定位到目录，更符合聊天附件预览预期。
            if (attachment.type === 'image') {
                await deps.openPath(attachment.path);
            } else {
                await deps.revealItemInDir(attachment.path);
            }
        } catch (error) {
            console.error('[SearchBar] Failed to preview attachment:', error);
        }
    }

    /**
     * 清空输入并关闭快速搜索面板。
     *
     * @returns void
     */
    function clearInput() {
        searchQuery.value = '';
        // 清空输入时关闭联想面板，避免展示过期候选。
        quickShortcuts.closeQuickSearchPanel();
    }

    // 6. 输入焦点工具
    /**
     * 判断光标是否位于输入框起始位置。
     *
     * @returns 光标位于起始位置时为 true。
     */
    function isCursorAtStart(): boolean {
        const input = searchInput.value;
        if (!input) return false;
        const start = input.selectionStart ?? 0;
        const end = input.selectionEnd ?? start;
        return start === 0 && end === 0;
    }

    /**
     * 将焦点置于搜索输入框。
     *
     * @returns Promise<void>
     */
    async function focus() {
        searchInput?.value?.focus();
    }

    return {
        searchQuery,
        searchInput,
        logoContainerRef,
        quickSearchPanel: quickShortcuts.quickSearchPanel,
        currentPlaceholder: modelSelection.currentPlaceholder,
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
        onInput,
        removeAttachment,
        previewAttachment,
        clearInput,
        isCursorAtStart,
        focus,
        loadActiveModel: modelSelection.loadActiveModel,
        handleContainerMouseDown: dragging.handleContainerMouseDown,
        handleInputMouseDown: dragging.handleInputMouseDown,
    };
}
