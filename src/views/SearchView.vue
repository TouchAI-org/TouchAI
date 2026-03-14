<script setup lang="ts">
    // Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

    import ConversationPanel from '@components/search/ConversationPanel.vue';
    import SearchBar from '@components/search/SearchBar/index.vue';
    import { useAgent } from '@composables/useAgent.ts';
    import { useAlert } from '@composables/useAlert';
    import { useWindowResize } from '@composables/useWindowResize';
    import {
        type AttachmentSupportStatus,
        createAttachment,
        type Index,
        isAttachmentSupported,
    } from '@services/AiService/attachments';
    import { native } from '@services/NativeService';
    import { popupManager } from '@services/PopupService';
    import { runStartupTasks } from '@services/StartupService';
    import { emit, listen } from '@tauri-apps/api/event';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { sendNotification } from '@tauri-apps/plugin-notification';
    import { readClipboard, ReadClipboardItem } from 'tauri-plugin-clipboard-x-api';
    import { computed, nextTick, onMounted, onUnmounted, ref, unref } from 'vue';

    import { useSettingsStore } from '@/stores/settings';

    const WINDOW_MAX_HEIGHT = 700;

    const searchQuery = ref('');
    const searchBar = ref<InstanceType<typeof SearchBar>>();
    const conversationPanel = ref<InstanceType<typeof ConversationPanel>>();
    const pageContainer = ref<HTMLElement | null>(null);
    const attachments = ref<Index[]>([]);
    const modelCapabilities = ref({ supportsImages: false, supportsFiles: false });
    const isPinned = ref(false);
    const isDragging = ref(false);
    // 开发模式下通过 Ctrl 暂停/恢复失焦隐藏，方便调试时切换 DevTools 而不触发窗口隐藏。
    const isDevBlurHideSuspended = ref(false);
    const isDevMode = import.meta.env.DEV;

    // 请求队列状态
    const pendingRequest = ref<{
        query: string;
        attachments: Index[];
        modelId?: string;
        providerId?: number;
    } | null>(null);
    const isWaitingForCompletion = ref(false);

    // 退格键双击检测
    let lastBackspaceTime = 0;
    const DOUBLE_BACKSPACE_INTERVAL = 300; // 300ms内连续按两次退格视为双击

    let unlistenFocus: (() => void) | null = null;
    let unlistenBlur: (() => void) | null = null;
    let unlistenPopupFocusMain: (() => void) | null = null;
    const settingsStore = useSettingsStore();

    const { isLoading, error, conversationHistory, sendRequest, cancel, clearConversation } =
        useAgent({
            onComplete: async () => {
                // 请求完成后，检查是否有待发送的请求
                if (pendingRequest.value) {
                    const {
                        query,
                        attachments: pendingAttachments,
                        modelId,
                        providerId,
                    } = pendingRequest.value;
                    pendingRequest.value = null;
                    isWaitingForCompletion.value = false;

                    // 清空搜索框和附件
                    searchBar.value?.clearInput({ preserveModelTag: true });
                    searchQuery.value = '';
                    attachments.value = [];

                    // 发送待处理的请求
                    await sendRequest(query, pendingAttachments, modelId, providerId);
                }
            },
        });

    useWindowResize({ target: pageContainer, maxHeight: WINDOW_MAX_HEIGHT });

    // 窗口隐藏超时管理
    const HIDE_TIMEOUT_MS = 5 * 60 * 1000; // 5分钟
    let lastHideTime: number | null = null;

    function recordHideTime() {
        lastHideTime = Date.now();
    }

    function checkAndClearIfTimeout() {
        if (lastHideTime === null) return;
        if (Date.now() - lastHideTime >= HIDE_TIMEOUT_MS) {
            clearConversation();
            lastHideTime = null;
        }
    }

    // 是否应该在失焦时隐藏窗口（只有置顶且有对话历史时才不隐藏，拖动时也不隐藏）
    const shouldHideOnBlur = computed(() => {
        if (isDragging.value) return false;
        if (isDevMode && isDevBlurHideSuspended.value) return false;
        return !(isPinned.value && conversationHistory.value.length > 0);
    });

    /**
     * 主窗口失焦处理
     */
    async function handleWindowBlur() {
        try {
            // 检查应用是否还有焦点
            const appFocused = await native.window.isAppFocused();

            // 如果应用完全失去焦点
            if (!appFocused) {
                // 无条件执行弹窗隐藏与状态重置，避免可见性检查导致状态残留
                await popupManager.hide();

                // 隐藏主窗口
                if (shouldHideOnBlur.value) {
                    // 仅在实际隐藏时记录时间，避免开发调试暂停隐藏时误触发超时清理。
                    recordHideTime();
                    await native.window.hideSearchWindow();
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
        // 前置校验：存在不支持的附件时阻止发送，提示用户移除附件或切换模型。
        // 此检查优先于队列排队和实际发送逻辑，防止用户误发不完整的请求。
        if (attachments.value.length > 0) {
            const unsupported = attachments.value.filter((a) => !isAttachmentSupported(a));
            if (unsupported.length > 0) {
                // 区分不支持的具体类型（图片/文件/两者），给出精确提示。
                const hasUnsupportedImage = unsupported.some(
                    (a) => a.supportStatus === 'unsupported-image'
                );
                const hasUnsupportedFile = unsupported.some(
                    (a) => a.supportStatus === 'unsupported-file'
                );
                let msg = '当前模型不支持';
                if (hasUnsupportedImage && hasUnsupportedFile) {
                    msg += '图片和文件';
                } else if (hasUnsupportedImage) {
                    msg += '图片';
                } else {
                    msg += '文件';
                }
                msg += '，请移除不支持的附件或切换模型';
                sendNotification({ title: 'TouchAI', body: msg });
                return;
            }
        }

        // 如果正在加载中，将请求加入队列
        if (isLoading.value) {
            // 如果已经有待处理的请求，不重复排队
            if (pendingRequest.value) {
                return;
            }

            const selectedModelId = unref(searchBar.value?.selectedModelId);
            const selectedProviderId = unref(searchBar.value?.selectedProviderId);
            const supportedAttachments = attachments.value.filter(isAttachmentSupported);

            pendingRequest.value = {
                query,
                attachments: supportedAttachments,
                modelId: selectedModelId || undefined,
                providerId: selectedProviderId || undefined,
            };

            isWaitingForCompletion.value = true;
            // 保留搜索框内容，文字会通过disabled状态变灰
            return;
        }

        const selectedModelId = unref(searchBar.value?.selectedModelId);
        const selectedProviderId = unref(searchBar.value?.selectedProviderId);
        const supportedAttachments = attachments.value.filter(isAttachmentSupported);

        // 清空搜索框和附件
        searchBar.value?.clearInput({ preserveModelTag: true });
        searchQuery.value = '';
        attachments.value = [];

        // 发送请求
        await sendRequest(
            query,
            supportedAttachments,
            selectedModelId || undefined,
            selectedProviderId || undefined
        );
    }

    // 处理清空事件（点击清除按钮）
    function handleClear() {
        searchQuery.value = '';
        attachments.value = [];
    }

    // 处理移除附件：fromEditor 为 true 表示由编辑器 NodeSync 触发（标签已删除），
    // 此时只需同步外层数组；否则还需联动删除编辑器中的标签节点。
    function handleRemoveAttachment(id: string, fromEditor = false) {
        const index = attachments.value.findIndex((a) => a.id === id);
        if (index !== -1) {
            attachments.value.splice(index, 1);
        }
        if (!fromEditor) {
            searchBar.value?.removeAttachmentTagById(id);
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
        attachments.value = [];
        clearConversation();
        searchBar.value?.clearInput();
    }

    // 取消当前请求
    function cancelRequest() {
        if (isLoading.value) {
            cancel();
        }
    }

    // 处理重新生成消息
    async function handleRegenerateMessage(messageId: string) {
        // 找到当前 AI 消息
        const messageIndex = conversationHistory.value.findIndex((m) => m.id === messageId);
        if (messageIndex === -1) return;

        // 找到对应的用户消息（前一条消息）
        if (messageIndex === 0) return; // 第一条消息不应该是 AI 消息
        const userMessage = conversationHistory.value[messageIndex - 1];
        if (!userMessage || userMessage.role !== 'user') return;

        // 重新发送用户消息
        const selectedModelId = unref(searchBar.value?.selectedModelId);
        const selectedProviderId = unref(searchBar.value?.selectedProviderId);
        const supportedAttachments = (userMessage.attachments || []).filter(isAttachmentSupported);

        await sendRequest(
            userMessage.content,
            supportedAttachments,
            selectedModelId || undefined,
            selectedProviderId || undefined
        );
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
            native.window.hideSearchWindow();
        }
    }

    // 键盘事件监听
    async function handleKeyDown(event: KeyboardEvent) {
        if (isDevMode && event.key === 'Control' && !event.repeat) {
            isDevBlurHideSuspended.value = !isDevBlurHideSuspended.value;
            return;
        }

        // Tab 键切换焦点到响应模块
        if (event.key === 'Tab' && conversationHistory.value.length > 0) {
            event.preventDefault();
            conversationPanel.value?.focus();
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

            // 优先级4: 如果没有输入内容并且也没有对话历史，即空窗口，那么隐藏窗口
            if (!searchQuery.value.trim() && conversationHistory.value.length === 0) {
                await getCurrentWindow().hide();
                return;
            }

            // 优先级5: 如果有对话历史，清空界面（会话保留在数据库）
            if (conversationHistory.value.length > 0) {
                clearConversation();
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

        // 如果快速搜索面板打开，根据高亮状态分流处理：
        // - 有高亮项：方向键导航 + Enter 打开高亮项（面板完全接管键盘）
        // - 无高亮项：仅 ArrowDown 激活高亮，Enter 关闭面板并发送会话
        //   其余按键交还编辑器（如 ArrowLeft/Right 移动光标）
        if (searchBar.value?.isQuickSearchOpen) {
            const hasHighlight = searchBar.value?.getHighlightedQuickShortcut?.() !== null;

            if (hasHighlight) {
                // 有高亮项：四向方向键转发，Enter 打开高亮项
                const directionMap = {
                    ArrowUp: 'up',
                    ArrowDown: 'down',
                    ArrowLeft: 'left',
                    ArrowRight: 'right',
                } as const;
                const direction = directionMap[event.key as keyof typeof directionMap];
                if (direction) {
                    event.preventDefault();
                    searchBar.value?.moveQuickSearchSelection?.(direction);
                    return;
                }
                if (event.key === 'Enter') {
                    event.preventDefault();
                    await searchBar.value?.openHighlightedQuickShortcut?.();
                    return;
                }
            } else {
                // 无高亮项：ArrowDown 激活首项高亮，其他方向键不拦截，Enter 关闭面板并发送
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    searchBar.value?.moveQuickSearchSelection?.('down');
                    return;
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    searchBar.value?.closeQuickSearchPanel?.();
                    if (searchQuery.value.trim()) {
                        await handleSubmit(searchQuery.value);
                    }
                    return;
                }
            }
        }

        // 如果快速搜索面板未打开且模型下拉框也未打开
        if (!searchBar.value?.isModelDropdownOpen && !searchBar.value?.isQuickSearchOpen) {
            // 按下键：仅在单行且有输入内容时打开快速搜索面板
            if (event.key === 'ArrowDown') {
                if (searchBar.value?.isMultiLine) {
                    return;
                }
                if (searchQuery.value.trim()) {
                    event.preventDefault();
                    searchBar.value?.openQuickSearchPanel?.();
                    return;
                }
            }
            // 按上键：仅单行时发送会话（多行时让 ProseMirror 处理光标移动）
            if (event.key === 'ArrowUp') {
                if (searchBar.value?.isMultiLine) {
                    return;
                }
                event.preventDefault();
                if (searchQuery.value.trim()) {
                    await handleSubmit(searchQuery.value);
                }
                return;
            }
        }

        if (event.key === 'Backspace') {
            // 如果下拉框打开，关闭下拉框
            if (searchBar.value?.isModelDropdownOpen) {
                searchBar.value?.closeModelDropdown();
                return;
            }

            // 如果有待处理的请求，检测双击退格
            if (pendingRequest.value) {
                const now = Date.now();
                const timeSinceLastBackspace = now - lastBackspaceTime;
                lastBackspaceTime = now;

                // 如果是双击退格（300ms内连续按两次）
                if (timeSinceLastBackspace < DOUBLE_BACKSPACE_INTERVAL) {
                    event.preventDefault();
                    // 取消待处理的请求，但不清空输入框
                    pendingRequest.value = null;
                    isWaitingForCompletion.value = false;
                    // 文字会自动恢复黑色（因为disabled变为false）
                    lastBackspaceTime = 0; // 重置计时器
                }
                return;
            }

            // 如果光标在开头且已选择模型，退格取消模型选择
            if (searchBar.value?.selectedModelId && searchBar.value?.isCursorAtStart?.()) {
                event.preventDefault();
                searchBar.value?.clearSelectedModel();
                return;
            }
        }

        // Enter 键提交查询（Shift+Enter 由 Tiptap 处理换行）
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            // 允许在加载时提交（会进入队列），但必须有内容
            if (searchQuery.value.trim()) {
                await handleSubmit(searchQuery.value);
            }
        }
    }

    async function initFocusListener() {
        unlistenFocus = await getCurrentWindow().listen('tauri://focus', async () => {
            // 检查是否超时，如果超时则清空界面
            checkAndClearIfTimeout();

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

                // 同步插入附件标签到编辑器
                searchBar.value?.addAttachmentTag({
                    attachmentId: attachment.id,
                    fileName: attachment.name,
                    fileType: attachment.type,
                    preview: attachment.preview,
                });
            }

            // 处理图片
            if (image) {
                await addAttachment('image', image.value);
            }

            if (files && files?.value?.length > 0) {
                // 并行创建附件（I/O 密集），然后顺序插入编辑器标签（避免并发修改编辑器状态）。
                const created = await Promise.all(
                    files.value.map((filePath) => createAttachment('file', filePath))
                );
                for (const attachment of created) {
                    attachment.supportStatus = getAttachmentSupportStatus(attachment);
                    attachments.value.push(attachment);

                    searchBar.value?.addAttachmentTag({
                        attachmentId: attachment.id,
                        fileName: attachment.name,
                        fileType: attachment.type,
                        preview: attachment.preview,
                    });
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
            await settingsStore.initialize();
            await native.shortcut.registerGlobalShortcut(settingsStore.globalShortcut);
        } catch (error) {
            console.error('[SearchView] Failed to initialize global shortcut:', error);

            // 发送系统通知
            const errorStr = String(error);
            let message = '注册快捷键失败';

            if (errorStr.includes('already registered') || errorStr.includes('已注册')) {
                message = '快捷键已被其他应用占用，请在设置中更换';
            } else if (errorStr.includes('invalid') || errorStr.includes('无效')) {
                message = '快捷键格式无效，请在设置中重新配置';
            } else if (errorStr.includes('Unknown key')) {
                message = '不支持的按键，请在设置中更换';
            }

            sendNotification({
                title: 'TouchAI - 快捷键注册失败',
                body: message,
            });
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

        // 使用捕获阶段，在 Tiptap 内部 keydown handler 之前拦截，
        // 确保方向键导航、Enter 提交等逻辑优先于 ProseMirror 默认行为。
        window.addEventListener('keydown', handleKeyDown, true);

        document.addEventListener('mousedown', handleSearchWindowMouseDown, true);
        document.body.addEventListener('click', handleSearchWindowClick);

        // 作为主窗口，执行启动任务
        await runStartupTasks();
    });

    onUnmounted(() => {
        // 清理全局键盘事件监听
        window.removeEventListener('keydown', handleKeyDown, true);
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
        <div v-if="conversationHistory.length > 0" class="w-full flex-1 overflow-hidden">
            <ConversationPanel
                ref="conversationPanel"
                :messages="conversationHistory"
                :is-loading="isLoading"
                :error="error"
                :is-pinned="isPinned"
                @pin-change="(value: boolean) => (isPinned = value)"
                @regenerate-message="handleRegenerateMessage"
                @drag-start="isDragging = true"
                @drag-end="isDragging = false"
            />
        </div>
        <div
            v-if="conversationHistory.length > 0"
            class="w-full border-t-[0.5px] border-gray-300/80"
        ></div>
        <SearchBar
            ref="searchBar"
            :disabled="isWaitingForCompletion"
            @search="handleSearch"
            @submit="handleSubmit"
            @clear="handleClear"
            @remove-attachment="handleRemoveAttachment"
            @model-change="handleModelChange"
            @drag-start="isDragging = true"
            @drag-end="isDragging = false"
        />
    </div>
</template>

<style scoped>
    .search-view-container {
        border: 1.5px solid var(--color-gray-300);
    }

    .search-view-container.loading {
        border: 2px solid transparent;
        background-image:
            linear-gradient(var(--color-background-primary), var(--color-background-primary)),
            linear-gradient(
                90deg,
                var(--color-blue-500),
                var(--color-violet-500),
                var(--color-pink-500),
                var(--color-violet-500),
                var(--color-blue-500)
            );
        background-origin: border-box;
        background-clip: padding-box, border-box;
        animation: border-flow 1.5s linear infinite;
    }

    @keyframes border-flow {
        0% {
            background-image:
                linear-gradient(var(--color-background-primary), var(--color-background-primary)),
                linear-gradient(
                    90deg,
                    var(--color-blue-500),
                    var(--color-violet-500),
                    var(--color-pink-500),
                    var(--color-violet-500),
                    var(--color-blue-500)
                );
        }
        25% {
            background-image:
                linear-gradient(var(--color-background-primary), var(--color-background-primary)),
                linear-gradient(
                    90deg,
                    var(--color-violet-500),
                    var(--color-pink-500),
                    var(--color-violet-500),
                    var(--color-blue-500),
                    var(--color-violet-500)
                );
        }
        50% {
            background-image:
                linear-gradient(var(--color-background-primary), var(--color-background-primary)),
                linear-gradient(
                    90deg,
                    var(--color-pink-500),
                    var(--color-violet-500),
                    var(--color-blue-500),
                    var(--color-violet-500),
                    var(--color-pink-500)
                );
        }
        75% {
            background-image:
                linear-gradient(var(--color-background-primary), var(--color-background-primary)),
                linear-gradient(
                    90deg,
                    var(--color-violet-500),
                    var(--color-blue-500),
                    var(--color-violet-500),
                    var(--color-pink-500),
                    var(--color-violet-500)
                );
        }
        100% {
            background-image:
                linear-gradient(var(--color-background-primary), var(--color-background-primary)),
                linear-gradient(
                    90deg,
                    var(--color-blue-500),
                    var(--color-violet-500),
                    var(--color-pink-500),
                    var(--color-violet-500),
                    var(--color-blue-500)
                );
        }
    }
</style>
