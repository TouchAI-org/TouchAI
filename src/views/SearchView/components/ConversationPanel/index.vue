<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div class="relative w-full">
        <div
            class="toolbar-fade-overlay absolute top-0 right-0 left-0 z-20 flex h-[4.5rem] cursor-grab items-start px-10 pt-3 active:cursor-grabbing"
            @mousedown="handleToolbarDragMouseDown"
        >
            <div class="w-full">
                <ConversationToolbar :is-pinned="isPinned" @pin-change="togglePinned" />
            </div>
        </div>

        <div
            ref="conversationContainer"
            tabindex="0"
            class="conversation-container custom-scrollbar bg-background-primary w-full overflow-y-auto px-10 pt-[4.5rem] pb-5"
            :style="{ maxHeight: `${maxHeight}px` }"
            @scroll="handleScroll"
            @wheel.passive="markUserScrollIntent"
            @pointerdown="markUserScrollIntent"
            @touchstart.passive="markUserScrollIntent"
            @keydown="handleScrollIntentByKeyboard"
        >
            <!-- 消息列表 -->
            <div ref="messageListRef" class="message-list">
                <div
                    v-for="(message, index) in messages"
                    :key="message.id"
                    :data-message-id="message.id"
                    :data-message-role="message.role"
                >
                    <MessageItem
                        :message="message"
                        :previous-message="index > 0 ? messages[index - 1] : undefined"
                        @regenerate="handleRegenerateMessage"
                    />
                </div>
            </div>
        </div>

        <!-- 跳到底部 -->
        <div
            v-if="showScrollToBottom"
            class="scroll-fade-overlay pointer-events-none absolute right-0 bottom-0 left-0 flex h-20 items-end justify-center rounded-lg pb-4"
        >
            <button
                class="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-lg transition-all hover:bg-gray-50 hover:shadow-xl"
                @click="scrollToBottom"
            >
                <SvgIcon name="arrow-down" class="h-5 w-5 text-gray-600" />
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
    import SvgIcon from '@components/SvgIcon.vue';
    import type { ConversationMessage } from '@composables/useAgent.ts';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { storeToRefs } from 'pinia';
    import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

    import { useSettingsStore } from '@/stores/settings';

    import ConversationToolbar from './components/ConversationToolbar.vue';
    import MessageItem from './components/MessageItem.vue';

    defineOptions({
        name: 'SearchConversationPanel',
    });

    interface Props {
        messages: ConversationMessage[];
        isLoading: boolean;
        error: Error | null;
        maxHeight?: number;
        isPinned?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        maxHeight: 600,
        isPinned: false,
    });

    const emit = defineEmits<{
        pinChange: [isPinned: boolean];
        regenerateMessage: [messageId: string];
        dragStart: [];
        dragEnd: [];
    }>();

    const conversationContainer = ref<HTMLElement | null>(null);
    const messageListRef = ref<HTMLElement | null>(null);
    const settingsStore = useSettingsStore();
    const { outputScrollBehavior } = storeToRefs(settingsStore);
    useScrollbarStabilizer(conversationContainer);
    const isPinned = computed(() => props.isPinned);
    const showScrollToBottom = ref(false);
    const isAutoScrollEnabled = ref(true);
    const lastScrollTop = ref(0);
    const lastUserScrollIntentAt = ref(0);
    const lastAutoScrollAt = ref(0);
    const USER_MESSAGE_SCROLL_GAP = 12;
    let messageListObserver: ResizeObserver | null = null;

    // 暴露 focus 方法
    function focus() {
        conversationContainer.value?.focus();
    }

    defineExpose({
        focus,
    });

    function togglePinned() {
        emit('pinChange', !props.isPinned);
    }

    function handleRegenerateMessage(messageId: string) {
        emit('regenerateMessage', messageId);
    }

    function shouldAutoScrollOnOutput(): boolean {
        return outputScrollBehavior.value === 'follow_output' && isAutoScrollEnabled.value;
    }

    async function handleToolbarDragMouseDown(event: MouseEvent) {
        if (event.button !== 0) {
            return;
        }

        const target = event.target as HTMLElement | null;
        if (target?.closest('[data-drag-exclude="true"]')) {
            return;
        }

        emit('dragStart');
        try {
            await getCurrentWindow().startDragging();
        } finally {
            setTimeout(() => {
                emit('dragEnd');
            }, 100);
        }
    }

    function markUserScrollIntent() {
        lastUserScrollIntentAt.value = Date.now();
    }

    function handleScrollIntentByKeyboard(event: KeyboardEvent) {
        if (
            ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Space'].includes(
                event.code
            ) ||
            ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
        ) {
            markUserScrollIntent();
        }
    }

    // 检查是否滚动到底部
    function isScrolledToBottom(container: HTMLElement | null): boolean {
        if (!container) return true;
        const { scrollTop, scrollHeight, clientHeight } = container;
        // 允许 5px 的误差
        return scrollHeight - scrollTop - clientHeight < 5;
    }

    // 检查内容是否超出容器（是否有滚动条）
    function hasScrollbar(): boolean {
        if (!conversationContainer.value) return false;
        const { scrollHeight, clientHeight } = conversationContainer.value;
        return scrollHeight > clientHeight;
    }

    // 处理容器滚动事件
    function handleScroll() {
        if (!conversationContainer.value) return;

        const container = conversationContainer.value;
        const currentScrollTop = container.scrollTop;
        const atBottom = isScrolledToBottom(container);
        const mode = outputScrollBehavior.value;

        if (mode === 'follow_output') {
            // 如果用户滚动到底部，恢复自动滚动并隐藏按钮
            if (atBottom) {
                isAutoScrollEnabled.value = true;
                showScrollToBottom.value = false;
            } else {
                // 仅在真实“向上滚动”时禁用自动滚动，避免内容高度变化误触发
                if (hasScrollbar()) {
                    const userScrolledUp = currentScrollTop < lastScrollTop.value - 1;
                    const hasRecentUserIntent = Date.now() - lastUserScrollIntentAt.value < 280;
                    const isLikelyProgrammaticScroll = Date.now() - lastAutoScrollAt.value < 180;
                    if (userScrolledUp && (hasRecentUserIntent || !isLikelyProgrammaticScroll)) {
                        isAutoScrollEnabled.value = false;
                        showScrollToBottom.value = true;
                    } else if (!isAutoScrollEnabled.value) {
                        showScrollToBottom.value = true;
                    }
                }
            }
        } else {
            isAutoScrollEnabled.value = false;
            showScrollToBottom.value = hasScrollbar() && !atBottom;
        }

        lastScrollTop.value = currentScrollTop;
    }

    function syncToBottom() {
        if (!conversationContainer.value) return;
        lastAutoScrollAt.value = Date.now();
        conversationContainer.value.scrollTop = conversationContainer.value.scrollHeight;
        lastScrollTop.value = conversationContainer.value.scrollTop;
    }

    function scrollToUserMessageTop(messageId: string, gap = USER_MESSAGE_SCROLL_GAP): boolean {
        if (!conversationContainer.value || !messageListRef.value) {
            return false;
        }

        const escapedMessageId =
            typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                ? CSS.escape(messageId)
                : messageId;
        const selector = `[data-message-id="${escapedMessageId}"]`;
        const target = messageListRef.value.querySelector<HTMLElement>(selector);
        if (!target) {
            return false;
        }

        const container = conversationContainer.value;
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const targetScrollTop = container.scrollTop + (targetRect.top - containerRect.top) - gap;

        lastAutoScrollAt.value = Date.now();
        container.scrollTop = Math.max(0, targetScrollTop);
        lastScrollTop.value = container.scrollTop;
        return true;
    }

    // 滚动到底部
    function scrollToBottom() {
        syncToBottom();
        isAutoScrollEnabled.value = outputScrollBehavior.value === 'follow_output';
        showScrollToBottom.value = false;
    }

    // 当消息变化时自动滚动到底部（仅在启用自动滚动时）
    watch(
        () => props.messages,
        async () => {
            if (!shouldAutoScrollOnOutput()) return;

            await nextTick();
            syncToBottom();
        },
        { deep: true }
    );

    // 重置自动滚动状态
    watch(
        () => props.messages.length,
        (newLength, oldLength) => {
            // 消息被清空（新请求开始）
            if (newLength === 0 && oldLength > 0) {
                isAutoScrollEnabled.value = outputScrollBehavior.value === 'follow_output';
                showScrollToBottom.value = false;
                lastScrollTop.value = 0;
            }
            // 新消息添加（用户提交了新请求）
            if (newLength > oldLength) {
                const appendedMessages = props.messages.slice(oldLength, newLength);
                const latestAppendedUserMessage = [...appendedMessages]
                    .reverse()
                    .find((message) => message.role === 'user');

                if (outputScrollBehavior.value === 'follow_output') {
                    // 新请求时重置为跟踪模式
                    isAutoScrollEnabled.value = true;
                    showScrollToBottom.value = false;
                    nextTick(() => {
                        syncToBottom();
                    });
                } else if (outputScrollBehavior.value === 'jump_to_top') {
                    isAutoScrollEnabled.value = false;
                    nextTick(() => {
                        if (latestAppendedUserMessage) {
                            scrollToUserMessageTop(latestAppendedUserMessage.id);
                        }
                        const atBottom = isScrolledToBottom(conversationContainer.value);
                        showScrollToBottom.value = hasScrollbar() && !atBottom;
                    });
                } else {
                    isAutoScrollEnabled.value = false;
                    const atBottom = isScrolledToBottom(conversationContainer.value);
                    showScrollToBottom.value = hasScrollbar() && !atBottom;
                }
            }
        }
    );

    watch(
        outputScrollBehavior,
        async (mode) => {
            isAutoScrollEnabled.value = mode === 'follow_output';

            if (!conversationContainer.value) {
                showScrollToBottom.value = false;
                return;
            }

            await nextTick();
            const atBottom = isScrolledToBottom(conversationContainer.value);
            showScrollToBottom.value = hasScrollbar() && !atBottom;
        },
        { immediate: true }
    );

    onMounted(async () => {
        await settingsStore.initialize();
        if (messageListRef.value) {
            messageListObserver = new ResizeObserver(() => {
                if (!shouldAutoScrollOnOutput()) {
                    return;
                }

                nextTick(() => {
                    syncToBottom();
                });
            });
            messageListObserver.observe(messageListRef.value);
        }
    });

    onUnmounted(() => {
        if (messageListObserver) {
            messageListObserver.disconnect();
            messageListObserver = null;
        }
    });
</script>

<style scoped>
    /* 移除焦点时的默认边框 */
    .conversation-container:focus {
        outline: none;
    }

    .message-list {
        margin-top: 1rem;
    }

    .toolbar-fade-overlay {
        background: linear-gradient(to bottom, var(--color-overlay-fade) 0%, transparent 100%);
    }

    .scroll-fade-overlay {
        background: linear-gradient(to bottom, transparent 0%, var(--color-overlay-fade) 100%);
    }
</style>
