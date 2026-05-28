<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div
        ref="searchBarContainerRef"
        data-testid="search-bar"
        class="search-bar-container relative flex h-full min-h-14 w-full items-center gap-2 p-3 transition duration-250 ease-in-out"
        @mousedown="handleContainerMouseDown"
    >
        <div
            :ref="assignLogoContainerRef"
            class="logo-container flex shrink-0 cursor-pointer items-center justify-center self-center"
            data-tauri-drag-region="false"
            @mouseenter="handleModelDropdownPrefetchRequest"
            @mousedown.stop.prevent="handleModelDropdownToggleRequest"
        >
            <ModelLogo
                v-if="selectedModel || activeModel"
                :model-id="selectedModel?.model_id || activeModel?.model_id || ''"
                :name="selectedModel?.name || activeModel?.name || 'model'"
                class="border-2 border-gray-300 transition-colors hover:border-gray-400"
            />
            <img v-else :src="logo" alt="TouchAI" class="h-8 w-8 object-contain select-none" />
        </div>

        <div
            ref="editorHostRef"
            data-testid="search-editor-host"
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
</template>

<script setup lang="ts">
    import logo from '@assets/logo.svg';
    import ModelLogo from '@components/ModelLogo.vue';
    import { EditorContent } from '@tiptap/vue-3';
    import type { ComponentPublicInstance } from 'vue';
    import { onMounted, onUnmounted, ref, toRefs, watch } from 'vue';

    import type { Index } from '@/services/AgentService/infrastructure/attachments';

    import { type ModelCapabilities, useSearchInput } from './composables/useSearchLogic';
    import { insertAttachmentTag } from './tags/attachment';
    import type { SearchCursorContext, SearchModelOverride } from './types';
    import { isSearchTagDomTarget, resolveMouseEventTarget } from './utils/tiptap';

    defineOptions({
        name: 'SearchBar',
    });

    interface Props {
        disabled?: boolean;
        queryText?: string;
        attachments?: Index[];
        modelOverride?: SearchModelOverride;
    }

    const props = withDefaults(defineProps<Props>(), {
        disabled: false,
        queryText: '',
        attachments: () => [],
        modelOverride: () => ({
            modelId: null,
            providerId: null,
        }),
    });

    const { disabled, queryText, attachments, modelOverride } = toRefs(props);
    const searchBarContainerRef = ref<HTMLElement | null>(null);
    const editorHostRef = ref<HTMLElement | null>(null);
    let selectionDragCleanup: (() => void) | null = null;

    const emit = defineEmits<{
        'update:queryText': [query: string];
        modelChange: [capabilities: ModelCapabilities];
        attachmentRemoveRequest: [id: string];
        dragStart: [];
        dragEnd: [];
        cursorContextChange: [context: SearchCursorContext];
        modelOverrideChange: [modelOverride: SearchModelOverride];
        requestPrefetchModelDropdown: [];
        requestToggleModelDropdown: [];
    }>();

    const searchInput = useSearchInput({
        searchBarContainerRef,
        editorHostRef,
        queryText,
        attachments,
        modelOverride,
        emitQueryText: (value) => emit('update:queryText', value),
        emitModelChange: (capabilities) => emit('modelChange', capabilities),
        emitModelOverrideChange: (value) => emit('modelOverrideChange', value),
        emitRemoveAttachmentRequest: (id) => emit('attachmentRemoveRequest', id),
        emitDragStart: () => emit('dragStart'),
        emitDragEnd: () => emit('dragEnd'),
    });

    const {
        editor,
        selectedModel,
        activeModel,
        prefetchModelDropdownData,
        invalidateModelDropdownData,
        prepareModelDropdownOpen,
        selectModelFromDropdown,
        getModelDropdownAnchor,
        getModelDropdownContext,
        isMultiLine,
        cursorAtStart,
        cursorAtTextStart,
        cursorAtEnd,
        focus,
        loadActiveModel,
        captureInputHistorySnapshot,
        restoreInputHistorySnapshot,
        handleContainerMouseDown,
        handleEditorMouseDown,
        initEditor,
        destroyEditor,
        onEditorClick,
    } = searchInput;
    const logoContainerRef = searchInput.logoContainerRef;

    function assignLogoContainerRef(el: Element | ComponentPublicInstance | null) {
        logoContainerRef.value = el as HTMLElement | null;
    }

    function handleModelDropdownToggleRequest() {
        emit('requestToggleModelDropdown');
    }

    function handleModelDropdownPrefetchRequest() {
        emit('requestPrefetchModelDropdown');
    }

    function emitCursorContext() {
        emit('cursorContextChange', {
            isMultiLine: isMultiLine.value,
            cursorAtStart: cursorAtStart.value,
            cursorAtTextStart: cursorAtTextStart.value,
            cursorAtEnd: cursorAtEnd.value,
        });
    }

    watch(
        () => [isMultiLine.value, cursorAtStart.value, cursorAtTextStart.value, cursorAtEnd.value],
        () => emitCursorContext(),
        { immediate: true, flush: 'sync' }
    );

    watch(
        disabled,
        (isDisabled) => {
            if (!isDisabled) {
                return;
            }

            // 禁用输入时主动移除编辑器焦点，避免失活编辑器继续接收键盘输入。
            editor.value?.view.dom.blur();
        },
        { flush: 'post' }
    );

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
            // 仅清除当前 cleanup 自己创建的引用，防止误清其他 cleanup。
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

            // 确认进入框选态后立即移除 mousemove，后面的移动由浏览器原生选区接管。
            window.removeEventListener('mousemove', handleMouseMove, true);
            host.classList.add('search-bar-editor-host--range-selecting');
        };

        const handleMouseUp = () => {
            cleanup();
        };

        // 保存 cleanup 引用，供 clearEditorSelectionDragState 和 onUnmounted 调用
        selectionDragCleanup = cleanup;
        // 使用捕获阶段，确保在 ProseMirror 内部事件处理前拦截。
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

    /**
     * 在光标位置插入文本（使用 ProseMirror 底层 API）。
     * @param text 要插入的文本
     */
    function insertTextAtCursor(text: string) {
        const ed = editor.value;
        if (!ed || !text) return;

        try {
            // 使用 ProseMirror 底层 API 精确控制插入位置
            const { view } = ed;
            const { state } = view;
            const { from, to } = state.selection;

            let tr = state.tr;

            // 删除选中的内容（如果有）
            if (from !== to) {
                tr = tr.delete(from, to);
            }

            // 将换行符替换为空格，避免创建新段落
            const normalizedText = text.replace(/\n/g, ' ');

            // 在光标位置插入纯文本
            tr = tr.insertText(normalizedText, tr.selection.from);

            // 应用 transaction
            view.dispatch(tr);
        } catch (error) {
            console.error('Failed to insert text at cursor:', error);
        }
    }

    function insertAttachmentAtCursor(
        attachmentId: string,
        fileName: string,
        fileType: 'image' | 'file',
        preview?: string,
        alias?: string
    ) {
        const ed = editor.value;
        if (!ed) return;

        try {
            const cursorPos = ed.view.state.selection.from;
            insertAttachmentTag(
                ed,
                {
                    attachmentId,
                    fileName,
                    fileType,
                    preview: preview || undefined,
                    alias: alias || '',
                },
                { textOffset: cursorPos }
            );
        } catch (error) {
            console.error('Failed to insert attachment at cursor:', error);
        }
    }

    defineExpose({
        prefetchModelDropdownData,
        invalidateModelDropdownData,
        prepareModelDropdownOpen,
        selectModelFromDropdown,
        getModelDropdownAnchor,
        getModelDropdownContext,
        focus,
        loadActiveModel,
        insertTextAtCursor,
        insertAttachmentAtCursor,
        captureInputHistorySnapshot,
        restoreInputHistorySnapshot,
    });
</script>

<style scoped src="./style.css"></style>
