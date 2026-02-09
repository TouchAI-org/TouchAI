<script setup lang="ts">
    // Copyright (c) 2025. Qian Cheng. Licensed under GPL v3.

    import ResponsePanel from '@components/search/ResponsePanel.vue';
    import SearchBar from '@components/search/SearchBar.vue';
    import { useAiRequest } from '@composables/useAiRequest';
    import { useAlert } from '@composables/useAlert';
    import { useWindowResize } from '@composables/useWindowResize';
    import { getSettingValue, setSetting } from '@database/queries';
    import {
        type AttachmentSupportStatus,
        createAttachment,
        type Index,
        isAttachmentSupported,
    } from '@services/AiService/attachments';
    import { popupManager } from '@services/PopupService';
    import { invoke } from '@tauri-apps/api/core';
    import { emit, listen } from '@tauri-apps/api/event';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { readClipboard, ReadClipboardItem } from 'tauri-plugin-clipboard-x-api';
    import { computed, nextTick, onMounted, onUnmounted, ref, unref } from 'vue';

    const DEFAULT_GLOBAL_SHORTCUT = 'Alt+Space';
    const WINDOW_MAX_HEIGHT = 700;

    const searchQuery = ref('');
    const searchBar = ref<InstanceType<typeof SearchBar>>();
    const responseDisplay = ref<InstanceType<typeof ResponsePanel>>();
    const pageContainer = ref<HTMLElement | null>(null);
    const attachments = ref<Index[]>([]);
    const modelCapabilities = ref({ supportsImages: false, supportsFiles: false });
    const isPinned = ref(false);
    const isDragging = ref(false);

    let unlistenFocus: (() => void) | null = null;
    let unlistenBlur: (() => void) | null = null;
    let unlistenPopupFocusMain: (() => void) | null = null;

    // 双击退格检测（仅用于取消请求）
    const lastBackspacePressTime = ref(0);
    const DOUBLE_PRESS_THRESHOLD = 150; // 150ms 内算双击

    const { isLoading, error, response, reasoning, hasResponse, sendRequest, reset, cancel } =
        useAiRequest();

    useWindowResize({ target: pageContainer, maxHeight: WINDOW_MAX_HEIGHT });

    // 是否应该在失焦时隐藏窗口（只有置顶且有响应内容时才不隐藏，拖动时也不隐藏）
    const shouldHideOnBlur = computed(() => {
        if (isDragging.value) return false;
        return !(isPinned.value && hasResponse.value);
    });

    /**
     * 主窗口失焦处理
     */
    async function handleWindowBlur() {
        try {
            // 检查应用是否还有焦点
            const appFocused = await invoke<boolean>('is_app_focused');

            // 如果应用完全失去焦点
            if (!appFocused) {
                // 无条件执行弹窗隐藏与状态重置，避免可见性检查导致状态残留
                await popupManager.hide();

                // 隐藏主窗口
                if (shouldHideOnBlur.value) {
                    await invoke('hide_search_window');
                }
            }
        } catch (error) {
            console.error('[SearchView] Failed to handle window blur:', error);
        }
    }

    function handleSearch(query: string) {
        searchQuery.value = query;
    }

    async function handleSubmit(query: string) {
        reset();

        const selectedModelId = unref(searchBar.value?.selectedModelId);
        const selectedProviderId = unref(searchBar.value?.selectedProviderId);

        const supportedAttachments = attachments.value.filter(isAttachmentSupported);

        await sendRequest(
            query,
            selectedModelId || undefined,
            selectedProviderId || undefined,
            supportedAttachments
        );
    }

    // 处理清空事件（点击清除按钮）
    function handleClear() {
        searchQuery.value = '';
        reset();
    }

    // 处理移除附件
    function handleRemoveAttachment(id: string) {
        const index = attachments.value.findIndex((a) => a.id === id);
        if (index !== -1) {
            attachments.value.splice(index, 1);
        }
    }

    function getAttachmentSupportStatus(attachment: Index): AttachmentSupportStatus {
        if (attachment.type === 'image' && !modelCapabilities.value.supportsImages) {
            return 'unsupported-image';
        }
        if (attachment.type === 'file' && !modelCapabilities.value.supportsFiles) {
            return 'unsupported-file';
        }
        return 'supported';
    }

    function syncAttachmentSupport() {
        attachments.value.forEach((attachment) => {
            attachment.supportStatus = getAttachmentSupportStatus(attachment);
        });
    }

    function handleModelChange(capabilities: { supportsImages: boolean; supportsFiles: boolean }) {
        modelCapabilities.value = capabilities;
        syncAttachmentSupport();
    }

    function clearAll() {
        searchQuery.value = '';
        reset();
        searchBar.value?.clearInput();
    }

    // 取消当前请求
    function cancelRequest() {
        if (isLoading.value) {
            cancel();
        }
    }

    function handleSearchWindowMouseDown(event: MouseEvent) {
        const target = event.target as HTMLElement | null;

        // 模型图标点击由自身 toggle 逻辑处理，避免被这里提前关闭后又重新打开
        if (target?.closest('.logo-container')) {
            return;
        }

        if (searchBar.value?.isAnyDropdownOpen?.()) {
            searchBar.value?.hideAllDropdowns?.();
            event.preventDefault();
            event.stopPropagation();
        }
    }

    function handleSearchWindowClick(event: MouseEvent) {
        if (event?.target == document.body) {
            invoke('hide_search_window');
        }
    }

    // 键盘事件监听
    async function handleKeyDown(event: KeyboardEvent) {
        const now = Date.now();

        // Tab 键切换焦点到响应模块
        if (event.key === 'Tab' && hasResponse.value) {
            event.preventDefault();
            responseDisplay.value?.focus();
            return;
        }

        // ESC 键处理
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();

            // 优先级1: 如果下拉框打开，关闭下拉框
            if (searchBar.value?.isModelDropdownOpen) {
                searchBar.value?.closeModelDropdown();
                return;
            }

            // 优先级2: 如果正在加载，取消请求
            if (isLoading.value) {
                cancelRequest();
                return;
            }

            // 优先级3: 如果输入为空且有选择模型，取消选择模型
            const hasSelectedModel = searchBar.value?.selectedModelId;
            if (!searchQuery.value.trim() && hasSelectedModel) {
                searchBar.value?.clearSelectedModel();
                return;
            }

            // 优先级4: 如果没有输入内容并且也没有结果，即空窗口，那么隐藏窗口
            if (!searchQuery.value.trim() && !hasResponse.value) {
                await getCurrentWindow().hide();
                return;
            }

            // 优先级5: 如果有响应，只清除响应但保留搜索文本
            if (hasResponse.value) {
                reset();
                return;
            }

            // 优先级6: 其他情况，清空所有内容
            clearAll();
            return;
        }

        // @ 键打开模型下拉框
        if (event.key === '@' && !searchBar.value?.isModelDropdownOpen) {
            event.preventDefault();
            searchBar.value?.openModelDropdown();
            return;
        }

        // 如果模型下拉框打开，方向键和 Enter 键转发到弹窗
        if (searchBar.value?.isModelDropdownOpen) {
            if (['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) {
                event.preventDefault();
                // 通过 Tauri 事件转发键盘事件到弹窗
                emit('popup-keydown', { key: event.key });
                return;
            }
        }

        if (!searchBar.value?.isModelDropdownOpen) {
            if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
                responseDisplay.value?.focus();
                return;
            }
        }

        if (event.key === 'Backspace') {
            // 如果下拉框打开，关闭下拉框
            if (searchBar.value?.isModelDropdownOpen) {
                searchBar.value?.closeModelDropdown();
                return;
            }

            // 如果光标在开头且已选择模型，退格取消模型选择
            if (searchBar.value?.selectedModelId && searchBar.value?.isCursorAtStart?.()) {
                event.preventDefault();
                searchBar.value?.clearSelectedModel();
                return;
            }

            // 双击退格键取消请求
            if (now - lastBackspacePressTime.value < DOUBLE_PRESS_THRESHOLD) {
                if (isLoading.value) {
                    cancelRequest();
                }
                lastBackspacePressTime.value = 0;
            } else {
                lastBackspacePressTime.value = now;
            }
        }

        // Enter 键提交查询
        if (event.key === 'Enter') {
            event.preventDefault();
            if (!isLoading.value && searchQuery.value.trim()) {
                await handleSubmit(searchQuery.value);
            }
        }
    }

    async function initFocusListener() {
        unlistenFocus = await getCurrentWindow().listen('tauri://focus', async () => {
            await nextTick();
            searchBar.value?.focus();
            searchBar.value?.loadActiveModel();
        });

        // 监听主窗口失焦
        unlistenBlur = await getCurrentWindow().listen('tauri://blur', async () => {
            await handleWindowBlur();
        });

        // 监听弹窗请求主窗口获得焦点的事件
        unlistenPopupFocusMain = await listen('popup-focus-main', async () => {
            // 将焦点设置到主窗口
            await getCurrentWindow().setFocus();
            // 延迟聚焦搜索框
            setTimeout(() => {
                searchBar.value?.focus();
            }, 50);
        });
    }

    // 处理粘贴事件
    async function handlePaste() {
        try {
            const clipboard: Partial<{
                text: { type: 'text'; value: string; count: number };
                rtf: { type: 'rtf'; value: string; count: number };
                html: { type: 'html'; value: string; count: number };
                image: ReadClipboardItem<'image'>;
                files: { type: 'files'; value: string[]; count: number };
            }> = await readClipboard();

            const { files, image } = clipboard;

            async function addAttachment(type: 'image' | 'file', path: string) {
                const attachment = await createAttachment(type, path);
                attachment.supportStatus = getAttachmentSupportStatus(attachment);
                attachments.value.push(attachment);
            }

            // 处理图片
            if (image) {
                await addAttachment('image', image.value);
            }

            if (files && files?.value?.length > 0) {
                for (const filePath of files.value) {
                    await addAttachment('file', filePath);
                }
            }
        } catch (error) {
            console.error('[SearchView] Failed to handle paste:', error);
        }
    }

    /**
     * 初始化全局快捷键
     */
    async function initializeGlobalShortcut() {
        try {
            const storedShortcut = await getSettingValue('global_shortcut');
            const shortcut = storedShortcut || DEFAULT_GLOBAL_SHORTCUT;

            if (!storedShortcut) {
                await setSetting('global_shortcut', DEFAULT_GLOBAL_SHORTCUT);
            }

            await invoke('register_global_shortcut', { shortcut });
        } catch (error) {
            console.error('[SearchView] Failed to initialize global shortcut:', error);
        }
    }

    /**
     * 初始化 SearchView 特定的功能
     */
    async function initializeSearchView() {
        try {
            // 1. 初始化全局快捷键
            await initializeGlobalShortcut();

            // 2. 初始化 Alert 系统
            useAlert();

            // 3. 初始化 Popup 管理器
            await popupManager.initialize();
        } catch (error) {
            console.error('[SearchView] Failed to initialize:', error);
        }
    }

    onMounted(async () => {
        // 初始化 SearchView 特定功能
        await initializeSearchView();

        // 初始化窗口获得焦点监听
        await initFocusListener();

        // 添加全局键盘事件监听
        window.addEventListener('keydown', handleKeyDown);

        document.addEventListener('mousedown', handleSearchWindowMouseDown, true);
        document.body.addEventListener('click', handleSearchWindowClick);
    });

    onUnmounted(() => {
        // 清理全局键盘事件监听
        window.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('mousedown', handleSearchWindowMouseDown, true);
        document.body.removeEventListener('click', handleSearchWindowClick);

        // 清理窗口焦点监听
        if (unlistenFocus) {
            unlistenFocus();
            unlistenFocus = null;
        }
        if (unlistenBlur) {
            unlistenBlur();
            unlistenBlur = null;
        }
        if (unlistenPopupFocusMain) {
            unlistenPopupFocusMain();
            unlistenPopupFocusMain = null;
        }
    });
</script>

<template>
    <div
        ref="pageContainer"
        :class="[
            'search-view-container bg-background-primary flex h-full w-full flex-col items-center justify-start overflow-hidden rounded-lg backdrop-blur-xl',
            isLoading ? 'loading' : '',
        ]"
        @paste="handlePaste"
    >
        <SearchBar
            ref="searchBar"
            :disabled="isLoading"
            :attachments="attachments"
            @search="handleSearch"
            @submit="handleSubmit"
            @clear="handleClear"
            @remove-attachment="handleRemoveAttachment"
            @model-change="handleModelChange"
            @drag-start="isDragging = true"
            @drag-end="isDragging = false"
        />
        <div v-if="hasResponse" class="w-full border-t-[0.5px] border-gray-300/80">
            <ResponsePanel
                ref="responseDisplay"
                :content="response"
                :reasoning="reasoning"
                :is-loading="isLoading"
                :error="error"
                :is-pinned="isPinned"
                @pin-change="(value: boolean) => (isPinned = value)"
            />
        </div>
    </div>
</template>

<style scoped>
    .search-view-container {
        border: 1.5px solid #d1d5db;
    }

    .search-view-container.loading {
        border: 2px solid transparent;
        background-image:
            linear-gradient(rgba(251, 251, 246, 0.98), rgba(251, 251, 246, 0.98)),
            linear-gradient(90deg, #3b82f6, #8b5cf6, #ec4899, #8b5cf6, #3b82f6);
        background-origin: border-box;
        background-clip: padding-box, border-box;
        animation: border-flow 1.5s linear infinite;
    }

    @keyframes border-flow {
        0% {
            background-image:
                linear-gradient(rgba(251, 251, 246, 0.98), rgba(251, 251, 246, 0.98)),
                linear-gradient(90deg, #3b82f6, #8b5cf6, #ec4899, #8b5cf6, #3b82f6);
        }
        25% {
            background-image:
                linear-gradient(rgba(251, 251, 246, 0.98), rgba(251, 251, 246, 0.98)),
                linear-gradient(90deg, #8b5cf6, #ec4899, #8b5cf6, #3b82f6, #8b5cf6);
        }
        50% {
            background-image:
                linear-gradient(rgba(251, 251, 246, 0.98), rgba(251, 251, 246, 0.98)),
                linear-gradient(90deg, #ec4899, #8b5cf6, #3b82f6, #8b5cf6, #ec4899);
        }
        75% {
            background-image:
                linear-gradient(rgba(251, 251, 246, 0.98), rgba(251, 251, 246, 0.98)),
                linear-gradient(90deg, #8b5cf6, #3b82f6, #8b5cf6, #ec4899, #8b5cf6);
        }
        100% {
            background-image:
                linear-gradient(rgba(251, 251, 246, 0.98), rgba(251, 251, 246, 0.98)),
                linear-gradient(90deg, #3b82f6, #8b5cf6, #ec4899, #8b5cf6, #3b82f6);
        }
    }
</style>
