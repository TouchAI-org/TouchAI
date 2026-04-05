<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div class="relative h-full min-h-0 w-full">
        <ConversationToolbar
            ref="conversationToolbar"
            :is-pinned="isPinned"
            :can-pin="messages.length > 0"
            :disabled="toolbarDisabled"
            :history-open="historyOpen"
            @pin-change="emit('pinChange', $event)"
            @new-session="emit('newSession')"
            @history-open-change="emit('historyOpenChange', $event)"
            @history-prefetch="emit('historyPrefetch', $event)"
            @wheel="scrollByDelta"
            @drag-start="emit('dragStart')"
            @drag-end="emit('dragEnd')"
        />
        <div
            ref="conversationContainer"
            tabindex="0"
            class="conversation-container bg-background-primary h-full min-h-0 w-full overflow-y-auto px-10 pt-[4.5rem] pb-5 focus:outline-none"
            :style="conversationContainerStyle"
            @scroll="handleScroll"
            @wheel.passive="markUserScrollIntent"
            @pointerdown="markUserScrollIntent"
            @touchstart.passive="markUserScrollIntent"
            @keydown="handleScrollIntentByKeyboard"
        >
            <!-- 消息列表 -->
            <div ref="messageListRef" class="mt-4">
                <div
                    v-for="message in messages"
                    :key="message.id"
                    :data-message-id="message.id"
                    :data-message-role="message.role"
                >
                    <MessageItem
                        :message="message"
                        :approval-attention-token="approvalAttentionToken"
                        @regenerate="handleRegenerateMessage"
                        @approve-tool-approval="handleApproveToolApproval"
                        @reject-tool-approval="handleRejectToolApproval"
                    />
                </div>
            </div>

            <!-- 对话时间轴 -->
            <ConversationTimeline
                :messages="messages"
                :container-height="maxHeight"
                :scroll-top="scrollTop"
                :scroll-height="scrollHeight"
                :client-height="clientHeight"
                @jump-to-message="handleTimelineJump"
            />
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
                <AppIcon name="arrow-down" class="h-5 w-5 text-gray-600" />
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import { storeToRefs } from 'pinia';
    import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

    import { useSettingsStore } from '@/stores/settings';
    import type { SessionMessage } from '@/types/session';

    import ConversationTimeline from './components/ConversationTimeline.vue';
    import ConversationToolbar from './components/ConversationToolbar.vue';
    import MessageItem from './components/MessageItem.vue';

    defineOptions({
        name: 'SearchConversationPanel',
    });

    interface Props {
        messages: SessionMessage[];
        isLoading: boolean;
        error: Error | null;
        isPinned: boolean;
        historyOpen: boolean;
        toolbarDisabled?: boolean;
        maxHeight?: number;
        approvalAttentionToken?: number;
    }

    const props = withDefaults(defineProps<Props>(), {
        maxHeight: 600,
        toolbarDisabled: false,
        approvalAttentionToken: 0,
    });

    const emit = defineEmits<{
        regenerateMessage: [messageId: string];
        pinChange: [isPinned: boolean];
        newSession: [];
        historyOpenChange: [payload: { open: boolean; anchorElement: HTMLElement | null }];
        historyPrefetch: [anchorElement: HTMLElement | null];
        approveToolApproval: [callId: string];
        rejectToolApproval: [callId: string];
        dragStart: [];
        dragEnd: [];
    }>();

    const conversationContainer = ref<HTMLElement | null>(null);
    const conversationToolbar = ref<{
        getHistoryAnchor: () => HTMLElement | null;
    } | null>(null);
    const messageListRef = ref<HTMLElement | null>(null);
    const settingsStore = useSettingsStore();
    const { outputScrollBehavior } = storeToRefs(settingsStore);
    useScrollbarStabilizer(conversationContainer);
    const showScrollToBottom = ref(false);
    const isAutoScrollEnabled = ref(true);
    const lastScrollTop = ref(0);
    const lastUserScrollIntentAt = ref(0);
    const lastAutoScrollAt = ref(0);
    const USER_MESSAGE_SCROLL_GAP = 12;
    const TIMELINE_JUMP_OFFSET = 80;
    let messageListObserver: ResizeObserver | null = null;

    // 时间轴相关状态
    const scrollTop = ref(0);
    const scrollHeight = ref(0);
    const clientHeight = ref(0);
    const conversationContainerStyle = computed(() => ({
        height: '100%',
        maxHeight: `${props.maxHeight}px`,
    }));

    // 暴露 focus 方法
    function focus() {
        conversationContainer.value?.focus();
    }

    /**
     * 切换历史会话时需要丢弃当前滚动状态，
     * 否则用户手动离底后的偏移会被带到新会话，初始视图会停在最早内容附近。
     */
    function revealLatestContent() {
        syncToBottom();
        isAutoScrollEnabled.value = outputScrollBehavior.value === 'follow_output';
        showScrollToBottom.value = false;
    }

    function scrollByDelta(deltaY: number) {
        if (!conversationContainer.value || deltaY === 0) {
            return;
        }

        markUserScrollIntent();
        conversationContainer.value.scrollTop += deltaY;
        handleScroll();
    }

    function getHistoryAnchor() {
        return conversationToolbar.value?.getHistoryAnchor() ?? null;
    }

    defineExpose({
        focus,
        revealLatestContent,
        scrollByDelta,
        getHistoryAnchor,
    });

    function handleRegenerateMessage(messageId: string) {
        emit('regenerateMessage', messageId);
    }

    function handleApproveToolApproval(callId: string) {
        emit('approveToolApproval', callId);
    }

    function handleRejectToolApproval(callId: string) {
        emit('rejectToolApproval', callId);
    }

    function shouldAutoScrollOnOutput(): boolean {
        return outputScrollBehavior.value === 'follow_output' && isAutoScrollEnabled.value;
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

        // 更新时间轴状态（仅在值变化时更新）
        if (scrollTop.value !== currentScrollTop) {
            scrollTop.value = currentScrollTop;
        }
        if (scrollHeight.value !== container.scrollHeight) {
            scrollHeight.value = container.scrollHeight;
        }
        if (clientHeight.value !== container.clientHeight) {
            clientHeight.value = container.clientHeight;
        }

        if (mode === 'follow_output') {
            if (atBottom) {
                isAutoScrollEnabled.value = true;
                showScrollToBottom.value = false;
            } else if (hasScrollbar()) {
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

    /**
     * 统一按当前位置刷新“跳到底部”按钮，避免时间轴跳转和消息追加各自维护一套显示条件。
     */
    function refreshScrollToBottomVisibility() {
        if (!conversationContainer.value) {
            showScrollToBottom.value = false;
            return;
        }

        const atBottom = isScrolledToBottom(conversationContainer.value);
        showScrollToBottom.value = hasScrollbar() && !atBottom;
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

    function handleTimelineJump(messageId: string) {
        const didJump = scrollToUserMessageTop(
            messageId,
            USER_MESSAGE_SCROLL_GAP + TIMELINE_JUMP_OFFSET
        );
        if (!didJump) {
            return;
        }

        // 时间轴点击等同用户手动上滚查看旧消息，直接标记用户自行滚动
        markUserScrollIntent();
        if (outputScrollBehavior.value === 'follow_output') {
            isAutoScrollEnabled.value = false;
        }
        refreshScrollToBottomVisibility();
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
                    /**
                     * 只有“新的用户提问”才代表一轮新请求开始，应当重新进入跟随模式。
                     * 如果只是用户点击时间轴后，AI继续产出新消息，则要保持停留在当前阅读位置。
                     */
                    if (latestAppendedUserMessage) {
                        isAutoScrollEnabled.value = true;
                        showScrollToBottom.value = false;
                        nextTick(() => {
                            syncToBottom();
                        });
                    } else if (!isAutoScrollEnabled.value) {
                        nextTick(() => {
                            refreshScrollToBottomVisibility();
                        });
                    }
                } else if (outputScrollBehavior.value === 'jump_to_top') {
                    isAutoScrollEnabled.value = false;
                    nextTick(() => {
                        if (latestAppendedUserMessage) {
                            scrollToUserMessageTop(latestAppendedUserMessage.id);
                        }
                        refreshScrollToBottomVisibility();
                    });
                } else {
                    isAutoScrollEnabled.value = false;
                    nextTick(() => {
                        refreshScrollToBottomVisibility();
                    });
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
            refreshScrollToBottomVisibility();
        },
        { immediate: true }
    );

    onMounted(async () => {
        await settingsStore.initialize();

        // 初始化时间轴滚动状态
        if (conversationContainer.value) {
            scrollTop.value = conversationContainer.value.scrollTop;
            scrollHeight.value = conversationContainer.value.scrollHeight;
            clientHeight.value = conversationContainer.value.clientHeight;
        }

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
    .conversation-container {
        scrollbar-width: none;
    }

    .conversation-container::-webkit-scrollbar {
        display: none;
    }

    .scroll-fade-overlay {
        background: linear-gradient(to bottom, transparent 0%, var(--color-overlay-fade) 100%);
    }
</style>
