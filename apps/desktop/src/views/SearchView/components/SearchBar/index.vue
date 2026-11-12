<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div
        ref="searchBarContainerRef"
        data-testid="search-bar"
        class="search-bar-container relative flex min-h-14 w-full shrink-0 gap-2 p-3"
        :class="isMultiLine ? 'items-start' : 'items-center'"
        @mousedown="handleContainerMouseDown"
    >
        <div
            :ref="assignLogoContainerRef"
            class="logo-container flex shrink-0 cursor-pointer items-center justify-center"
            data-tauri-drag-region="false"
            @mouseenter="handleModelDropdownPrefetchRequest"
            @mousedown.stop.prevent="handleModelDropdownToggleRequest"
        >
            <ModelLogo
                v-if="selectedModel || activeModel"
                :model-id="selectedModel?.model_id || activeModel?.model_id || ''"
                :name="selectedModel?.name || activeModel?.name || 'model'"
                class="border-2 border-model-logo-border transition-colors hover:border-model-logo-border-hover"
            />
            <img v-else :src="searchLogo" alt="TouchAI" class="h-8 w-8 select-none" />
        </div>

        <div
            ref="editorHostRef"
            data-testid="search-editor-host"
            class="search-bar-editor-host custom-scrollbar-thin flex min-h-0 flex-1 cursor-default self-stretch overflow-y-auto"
            :class="[
                disabled ? 'pointer-events-none opacity-60' : '',
                isMultiLine ? 'items-start' : 'items-center',
            ]"
            :style="{ maxHeight: 'calc(1.5em * 7 + 8px)' }"
            @click="onEditorClick"
            @mousedown.capture="handleEditorSelectionMouseDown"
        >
            <!--
              Keep the mounted Tiptap wrapper stretchable in the flex host.
              Without this, an empty line can collapse to ~0px and the caret becomes invisible
              until the user types a real character.
            -->
            <div class="search-bar-editor-content w-full min-w-0 flex-1">
                <EditorContent v-if="editor" :editor="editor" />
            </div>
        </div>
    </div>
    <slot name="results" :skill-picker="skillPickerState" :select-skill="selectSkillCandidate" />
</template>

<script setup lang="ts">
    import searchLogo from '@assets/logo.svg';
    import ModelLogo from '@components/ModelLogo.vue';
    import { log } from '@services/ObservabilityService';
    import { EditorContent } from '@tiptap/vue-3';
    import type { ComponentPublicInstance } from 'vue';
    import { computed, onMounted, onUnmounted, ref, toRefs, useId, watch } from 'vue';

    import type { Index } from '@/services/AgentService/infrastructure/attachments';
    import type { SelectedSkill, SkillMetadata } from '@/services/AgentService/skills';

    import { type ModelCapabilities, useSearchInput } from './composables/useSearchLogic';
    import type { SkillPickerState } from './composables/useSkillAutocomplete';
    import { insertAttachmentTag } from './tags/attachment';
    import type { FilePickerContext, SearchCursorContext, SearchModelOverride } from './types';
    import {
        insertPlainTextAtSelection,
        isSearchTagDomTarget,
        resolveMouseEventTarget,
    } from './utils/tiptap';

    defineOptions({
        name: 'SearchBar',
    });

    interface Props {
        disabled?: boolean;
        queryText?: string;
        attachments?: Index[];
        modelOverride?: SearchModelOverride;
        autoSelectFirst?: boolean;
        showEmptyResults?: boolean;
        completeFile?: (index?: number) => Index | null;
        moveFileSelection?: (direction: 'up' | 'down' | 'left' | 'right') => boolean;
        filePickerContext?: FilePickerContext | null;
        startDragging: (event: MouseEvent) => Promise<void>;
    }

    const props = withDefaults(defineProps<Props>(), {
        disabled: false,
        autoSelectFirst: false,
        showEmptyResults: false,
        queryText: '',
        attachments: () => [],
        completeFile: undefined,
        moveFileSelection: undefined,
        filePickerContext: null,
        modelOverride: () => ({
            modelId: null,
            providerId: null,
        }),
    });

    const {
        disabled,
        queryText,
        attachments,
        modelOverride,
        autoSelectFirst,
        completeFile,
        moveFileSelection,
        filePickerContext,
    } = toRefs(props);
    const searchBarContainerRef = ref<HTMLElement | null>(null);
    const editorHostRef = ref<HTMLElement | null>(null);
    let selectionDragCleanup: (() => void) | null = null;

    const emit = defineEmits<{
        'update:queryText': [query: string];
        modelChange: [capabilities: ModelCapabilities];
        attachmentRemoveRequest: [id: string];
        attachmentRestoreRequest: [attachment: Index];
        dragStart: [];
        dragEnd: [];
        cursorContextChange: [context: SearchCursorContext];
        modelOverrideChange: [modelOverride: SearchModelOverride];
        skillAutocompleteOpenChange: [open: boolean];
        skillInputActiveChange: [active: boolean];
        fileAutocompleteQueryChange: [query: string | null];
        fileInputActiveChange: [active: boolean];
        skillsChange: [skills: SelectedSkill[]];
        requestPrefetchModelDropdown: [];
        requestToggleModelDropdown: [];
    }>();

    const searchInput = useSearchInput({
        searchBarContainerRef,
        editorHostRef,
        queryText,
        attachments,
        modelOverride,
        autoSelectFirst,
        completeFile,
        moveFileSelection,
        filePickerContext,
        emitQueryText: (value) => emit('update:queryText', value),
        emitModelChange: (capabilities) => emit('modelChange', capabilities),
        emitModelOverrideChange: (value) => emit('modelOverrideChange', value),
        emitRemoveAttachmentRequest: (id) => emit('attachmentRemoveRequest', id),
        emitRestoreAttachmentRequest: (attachment) => emit('attachmentRestoreRequest', attachment),
        emitDragStart: () => emit('dragStart'),
        emitDragEnd: () => emit('dragEnd'),
        startDragging: props.startDragging,
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
        insertSkillAtCursor,
        loadActiveModel,
        skillAutocomplete,
        skillInputActive,
        fileAutocomplete,
        fileInputActive,
        completeFileReference,
        selectedSkills,
        captureInputHistorySnapshot,
        captureSearchActivationInput,
        restoreInputHistorySnapshot,
        handleContainerMouseDown,
        handleEditorMouseDown,
        initEditor,
        destroyEditor,
        onEditorClick,
    } = searchInput;
    const logoContainerRef = searchInput.logoContainerRef;
    const skillListId = `skill-picker-${useId()}`;
    const skillAutocompleteCandidates = skillAutocomplete.candidates;
    const skillAutocompleteOpen = computed<boolean>((wasOpen) => {
        if (!skillAutocomplete.isOpen.value) return false;
        if (props.showEmptyResults || skillAutocompleteCandidates.value.length) return true;
        // Pending queries retain visibility without reopening an empty launcher.
        return skillAutocomplete.isLoading.value && wasOpen === true;
    });
    const skillAutocompleteHighlightedIndex = skillAutocomplete.highlightedIndex;
    const skillPickerState = computed<SkillPickerState | null>(() =>
        skillAutocompleteOpen.value
            ? {
                  listId: skillListId,
                  query: skillAutocomplete.query.value,
                  loading: skillAutocomplete.isLoading.value,
                  error: skillAutocomplete.error.value,
                  candidates: skillAutocompleteCandidates.value,
                  highlightedIndex: skillAutocompleteHighlightedIndex.value,
              }
            : null
    );
    defineSlots<{
        results(props: {
            skillPicker: SkillPickerState | null;
            selectSkill: (skill: SkillMetadata) => void;
        }): unknown;
    }>();
    watch(selectedSkills, (skills) => emit('skillsChange', skills), { flush: 'sync' });
    watch(skillInputActive, (active) => emit('skillInputActiveChange', active), {
        immediate: true,
        flush: 'sync',
    });
    watch(fileAutocomplete.query, (query) => emit('fileAutocompleteQueryChange', query), {
        immediate: true,
        flush: 'sync',
    });
    watch(fileInputActive, (active) => emit('fileInputActiveChange', active), {
        immediate: true,
        flush: 'sync',
    });

    watch(
        [
            skillAutocompleteOpen,
            skillAutocompleteHighlightedIndex,
            skillAutocompleteCandidates,
            editor,
            fileAutocomplete.query,
            filePickerContext,
        ],
        () => {
            const dom = editor.value?.view.dom;
            if (!dom) return;
            dom.setAttribute('role', 'combobox');
            dom.setAttribute('aria-autocomplete', 'both');
            const fileOpen = fileAutocomplete.query.value !== null && !!filePickerContext.value;
            dom.setAttribute('aria-expanded', String(skillAutocompleteOpen.value || fileOpen));
            if (fileOpen && filePickerContext.value)
                dom.setAttribute('aria-controls', filePickerContext.value.listId);
            else if (skillAutocompleteOpen.value) dom.setAttribute('aria-controls', skillListId);
            else dom.removeAttribute('aria-controls');
            const activeId = `${skillListId}-${skillAutocompleteHighlightedIndex.value}`;
            if (fileOpen && filePickerContext.value?.activeItemId) {
                dom.setAttribute('aria-activedescendant', filePickerContext.value.activeItemId);
            } else if (
                skillAutocompleteOpen.value &&
                skillAutocompleteCandidates.value.length &&
                skillAutocompleteHighlightedIndex.value >= 0
            ) {
                dom.setAttribute('aria-activedescendant', activeId);
            } else dom.removeAttribute('aria-activedescendant');
        },
        { flush: 'post' }
    );

    function assignLogoContainerRef(el: Element | ComponentPublicInstance | null) {
        logoContainerRef.value = el as HTMLElement | null;
    }

    function handleModelDropdownToggleRequest() {
        emit('requestToggleModelDropdown');
    }

    function handleModelDropdownPrefetchRequest() {
        emit('requestPrefetchModelDropdown');
    }

    function selectSkillCandidate(skill: SkillMetadata) {
        skillAutocomplete.selectSkill(skill);
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
            editor.value?.setEditable(!isDisabled);
            if (!isDisabled) return;
            skillAutocomplete.close();
            fileAutocomplete.close();

            // 禁用输入时主动移除编辑器焦点，避免失活编辑器继续接收键盘输入。
            editor.value?.view.dom.blur();
        },
        { flush: 'post' }
    );

    watch(
        skillAutocompleteOpen,
        (isOpen) => {
            emit('skillAutocompleteOpenChange', isOpen);
        },
        { immediate: true, flush: 'post' }
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
        if (handleEditorMouseDown(event)) {
            return;
        }

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
        editor.value?.setEditable(!disabled.value);
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
            insertPlainTextAtSelection(ed, text);
        } catch (error) {
            log.error('Failed to insert text at cursor:', error);
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
            insertAttachmentTag(
                ed,
                {
                    attachmentId,
                    fileName,
                    fileType,
                    preview: preview || undefined,
                    alias: alias || '',
                },
                { atCurrentSelection: true }
            );
        } catch (error) {
            log.error('Failed to insert attachment at cursor:', error);
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
        insertSkillAtCursor: (skill: SelectedSkill) => insertSkillAtCursor(skill),
        isSkillAutocompleteOpen: () => skillAutocompleteOpen.value,
        isSkillAutocompleteActive: () => skillAutocomplete.activeTrigger.value !== null,
        closeSkillAutocomplete: skillAutocomplete.close,
        isFileAutocompleteOpen: () => fileAutocomplete.query.value !== null,
        closeFileAutocomplete: fileAutocomplete.close,
        completeFileReference,
        captureInputHistorySnapshot,
        captureSearchActivationInput,
        restoreInputHistorySnapshot,
    });
</script>

<style scoped src="./style.css"></style>
