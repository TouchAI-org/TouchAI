<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div class="relative w-full">
        <div
            ref="conversationContainer"
            tabindex="0"
            class="conversation-container custom-scrollbar bg-background-primary w-full overflow-y-auto px-10 py-5"
            :style="{ maxHeight: `${maxHeight}px` }"
            @scroll="handleScroll"
        >
            <ConversationToolbar :is-pinned="isPinned" @pin-change="togglePinned" />

            <!-- 消息列表 -->
            <div class="message-list">
                <MessageItem
                    v-for="(message, index) in messages"
                    :key="message.id"
                    :message="message"
                    :previous-message="index > 0 ? messages[index - 1] : undefined"
                    @regenerate="handleRegenerateMessage"
                />
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
    import SvgIcon from '@components/common/SvgIcon.vue';
    import ConversationToolbar from '@components/search/ConversationToolbar.vue';
    import MessageItem from '@components/search/MessageItem.vue';
    import type { ConversationMessage } from '@composables/useAgent.ts';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import { computed, nextTick, ref, watch } from 'vue';

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
    }>();

    const conversationContainer = ref<HTMLElement | null>(null);
    useScrollbarStabilizer(conversationContainer);
    const isPinned = computed(() => props.isPinned);
    const showScrollToBottom = ref(false);
    const isAutoScrollEnabled = ref(true);

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

        const atBottom = isScrolledToBottom(conversationContainer.value);

        // 如果用户滚动到底部，恢复自动滚动并隐藏按钮
        if (atBottom) {
            isAutoScrollEnabled.value = true;
            showScrollToBottom.value = false;
        } else {
            // 如果用户向上滚动且内容超出容器，禁用自动滚动并显示按钮
            if (hasScrollbar()) {
                isAutoScrollEnabled.value = false;
                showScrollToBottom.value = true;
            }
        }
    }

    // 滚动到底部
    function scrollToBottom() {
        if (!conversationContainer.value) return;
        conversationContainer.value.scrollTop = conversationContainer.value.scrollHeight;
        isAutoScrollEnabled.value = true;
        showScrollToBottom.value = false;
    }

    // 当消息变化时自动滚动到底部（仅在启用自动滚动时）
    watch(
        () => props.messages,
        async () => {
            if (!isAutoScrollEnabled.value) return;

            await nextTick();
            if (conversationContainer.value) {
                conversationContainer.value.scrollTop = conversationContainer.value.scrollHeight;
            }
        },
        { deep: true }
    );

    // 重置自动滚动状态
    watch(
        () => props.messages.length,
        (newLength, oldLength) => {
            // 消息被清空（新请求开始）
            if (newLength === 0 && oldLength > 0) {
                isAutoScrollEnabled.value = true;
                showScrollToBottom.value = false;
            }
            // 新消息添加（用户提交了新请求）
            if (newLength > oldLength) {
                // 启用自动滚动并滚动到底部
                isAutoScrollEnabled.value = true;
                showScrollToBottom.value = false;
                nextTick(() => {
                    if (conversationContainer.value) {
                        conversationContainer.value.scrollTop =
                            conversationContainer.value.scrollHeight;
                    }
                });
            }
        }
    );
</script>

<style scoped>
    /* 移除焦点时的默认边框 */
    .conversation-container:focus {
        outline: none;
    }

    .message-list {
        margin-top: 1rem;
    }

    .scroll-fade-overlay {
        background: linear-gradient(to bottom, transparent 0%, var(--color-overlay-fade) 100%);
    }
</style>
