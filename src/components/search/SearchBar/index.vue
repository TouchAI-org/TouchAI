<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div ref="containerRef" class="relative mx-auto h-full w-full">
        <div
            class="search-bar-container relative flex h-full min-h-14 w-full items-center gap-2 p-3 transition-all duration-250 ease-in-out"
            @mousedown="handleContainerMouseDown"
        >
            <div
                ref="logoContainerRef"
                class="logo-container flex shrink-0 cursor-pointer items-center justify-center self-center"
                data-tauri-drag-region="false"
                @mousedown.stop.prevent="toggleModelDropdown"
            >
                <ModelLogo
                    v-if="selectedModelId || activeModel"
                    :model-id="selectedModelId || activeModel?.model_id || ''"
                    :name="selectedModelName || activeModel?.name || 'model'"
                    class="border-2 border-gray-300 transition-colors hover:border-gray-400"
                />
                <img v-else :src="logoWord" alt="search" class="h-8 w-15 select-none" />
            </div>

            <div
                ref="editorHostRef"
                class="search-bar-editor-host custom-scrollbar-thin flex min-h-0 flex-1 cursor-default self-stretch overflow-y-auto"
                :class="[
                    disabled ? 'pointer-events-none opacity-60' : '',
                    isMultiLine ? 'items-start' : 'items-center',
                ]"
                :style="{ maxHeight: 'calc(1.5em * 3 + 8px)' }"
                @click="onEditorClick"
                @mousedown.capture="handleEditorSelectionMouseDown"
                @mousedown="handleEditorMouseDown"
            >
                <EditorContent v-if="editor" :editor="editor" />
            </div>
        </div>

        <QuickSearchPanel
            ref="quickSearchPanel"
            :search-query="searchQuery"
            :enabled="quickSearchEnabled && !isModelDropdownOpen"
        />
    </div>
</template>

<script setup lang="ts">
    import logoWord from '@assets/logo-word.svg';
    import ModelLogo from '@components/common/ModelLogo.vue';
    import QuickSearchPanel from '@components/search/QuickSearchPanel/index.vue';
    import { EditorContent } from '@tiptap/vue-3';
    import { onMounted, onUnmounted, ref, toRef, toRefs } from 'vue';

    import { isSearchTagDomTarget, resolveMouseEventTarget } from './tiptap';
    import { type ModelCapabilities, useSearchInput } from './useSearchLogic';

    defineOptions({
        name: 'SearchBar',
    });

    interface Props {
        disabled?: boolean;
        quickSearchEnabled?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        disabled: false,
        quickSearchEnabled: true,
    });

    const { disabled, quickSearchEnabled } = toRefs(props);
    const containerRef = ref<HTMLElement | null>(null);
    const editorHostRef = ref<HTMLElement | null>(null);
    let selectionDragCleanup: (() => void) | null = null;

    const emit = defineEmits<{
        search: [query: string];
        submit: [query: string];
        clear: [];
        modelChange: [capabilities: ModelCapabilities];
        removeAttachment: [id: string, fromEditor?: boolean];
        dragStart: [];
        dragEnd: [];
    }>();

    const {
        logoContainerRef,
        quickSearchPanel,
        searchQuery,
        editor,
        selectedModelId,
        selectedModelName,
        selectedProviderId,
        activeModel,
        isModelDropdownOpen,
        isQuickSearchOpen,
        isAnyDropdownOpen,
        toggleModelDropdown,
        closeModelDropdown,
        hideAllDropdowns,
        openModelDropdown,
        clearSelectedModel,
        openQuickSearchPanel,
        closeQuickSearchPanel,
        moveQuickSearchSelection,
        getHighlightedQuickShortcut,
        openHighlightedQuickShortcut,
        clearInput,
        isCursorAtStart,
        isMultiLine,
        focus,
        loadActiveModel,
        handleContainerMouseDown,
        handleEditorMouseDown,
        initEditor,
        destroyEditor,
        onEditorClick,
        addAttachmentTag,
        removeAttachmentTagById,
    } = useSearchInput({
        quickSearchEnabled: toRef(props, 'quickSearchEnabled'),
        editorHostRef,
        emitSearch: (query) => emit('search', query),
        emitModelChange: (capabilities) => emit('modelChange', capabilities),
        emitRemoveAttachment: (id, fromEditor) => emit('removeAttachment', id, fromEditor),
        emitDragStart: () => emit('dragStart'),
        emitDragEnd: () => emit('dragEnd'),
    });

    /** 清理文本选区拖拽跟踪状态和全局事件监听。 */
    function clearEditorSelectionDragState() {
        selectionDragCleanup?.();
        selectionDragCleanup = null;
        editorHostRef.value?.classList.remove('search-bar-editor-host--range-selecting');
    }

    /**
     * 检测编辑器宿主区域的文本框选手势。
     *
     * 问题背景：编辑器内的标签节点（model / attachment）是 contenteditable=false 的
     * 原子元素，自带 pointer-events。用户从文本区域拖选经过标签时，浏览器事件链
     * 会被标签截断，导致选区中断。
     *
     * 解决方式：在 mousedown 捕获阶段注册全局 mousemove/mouseup，
     * 当拖拽距离超过阈值后给宿主容器添加 CSS 类
     * `search-bar-editor-host--range-selecting`（使标签 pointer-events: none），
     * 让鼠标事件穿透标签，浏览器选区即可连续跨越。mouseup 时移除该类恢复交互。
     */
    function handleEditorSelectionMouseDown(event: MouseEvent) {
        const host = editorHostRef.value;
        // 仅响应左键
        if (!host || event.button !== 0) {
            return;
        }

        const target = resolveMouseEventTarget(event);

        // 点击在标签自身上时不介入，交给标签自己的交互处理
        if (!target || isSearchTagDomTarget(target)) {
            return;
        }

        // 清理可能残留的上一轮跟踪状态（例如上次 mouseup 未正常触发）
        clearEditorSelectionDragState();

        const startX = event.clientX;
        const startY = event.clientY;
        // 2px 阈值区分"点击"与"拖选"，避免普通点击误触发框选态
        const dragThreshold = 2;

        const cleanup = () => {
            window.removeEventListener('mousemove', handleMouseMove, true);
            window.removeEventListener('mouseup', handleMouseUp, true);
            host.classList.remove('search-bar-editor-host--range-selecting');
            // 仅清除自己创建的引用，防止误清后续新注册的 cleanup
            if (selectionDragCleanup === cleanup) {
                selectionDragCleanup = null;
            }
        };

        const handleMouseMove = (moveEvent: MouseEvent) => {
            // 移动距离不足阈值，视为点击抖动，忽略
            if (
                Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < dragThreshold
            ) {
                return;
            }

            // 确认进入框选态后立即移除 mousemove，后续移动由浏览器原生选区接管。
            window.removeEventListener('mousemove', handleMouseMove, true);
            host.classList.add('search-bar-editor-host--range-selecting');
        };

        const handleMouseUp = () => {
            cleanup();
        };

        // 保存 cleanup 引用，供 clearEditorSelectionDragState 和 onUnmounted 调用
        selectionDragCleanup = cleanup;
        // 使用捕获阶段，确保在 ProseMirror 内部事件处理之前拦截
        window.addEventListener('mousemove', handleMouseMove, true);
        window.addEventListener('mouseup', handleMouseUp, true);
    }

    onMounted(() => {
        initEditor();
    });

    onUnmounted(() => {
        clearEditorSelectionDragState();
        destroyEditor();
    });

    defineExpose({
        selectedModelId,
        selectedProviderId,
        isModelDropdownOpen,
        isQuickSearchOpen,
        isAnyDropdownOpen,
        clearSelectedModel,
        closeModelDropdown,
        closeQuickSearchPanel,
        hideAllDropdowns,
        openModelDropdown,
        openQuickSearchPanel,
        moveQuickSearchSelection,
        getHighlightedQuickShortcut,
        openHighlightedQuickShortcut,
        focus,
        clearInput,
        loadActiveModel,
        isCursorAtStart,
        isMultiLine,
        addAttachmentTag,
        removeAttachmentTagById,
    });
</script>

<style scoped src="./style.css"></style>
