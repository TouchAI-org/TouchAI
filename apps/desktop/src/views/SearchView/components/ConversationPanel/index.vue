<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div class="relative w-full" :class="props.fillAvailableHeight ? 'h-full min-h-0' : ''">
        <div
            ref="conversationContainer"
            tabindex="0"
            class="conversation-container bg-background-primary min-h-0 w-full overflow-y-auto px-10 pt-[4.5rem] pb-5 focus:outline-none"
            :class="props.fillAvailableHeight ? 'h-full' : ''"
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
                    <MessageItem :message="message" @regenerate="handleRegenerateMessage" />
                </div>
            </div>

            <!-- 对话时间轴 -->
            <ConversationTimeline
                ref="timelineRef"
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
                class="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full bg-white shadow-lg transition-all hover:bg-gray-50 hover:shadow-xl"
                @click="scrollToBottom"
            >
                <AppIcon name="arrow-down" class="h-4 w-4 text-gray-600" />
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';

    import { useSettingsStore } from '@/stores/settings';
    import type { SessionMessage } from '@/types/session';

    import ConversationTimeline from './components/ConversationTimeline.vue';
    import MessageItem from './components/MessageItem.vue';

    defineOptions({
        name: 'SearchConversationPanel',
    });

    interface Props {
        messages: SessionMessage[];
        isLoading: boolean;
        error: Error | null;
        isPinned: boolean;
        isMaximized?: boolean;
        fillAvailableHeight?: boolean;
        historyOpen: boolean;
        toolbarDisabled?: boolean;
        maxHeight?: number;
    }

    const props = withDefaults(defineProps<Props>(), {
        maxHeight: 600,
        toolbarDisabled: false,
        isMaximized: false,
        fillAvailableHeight: false,
    });

    const emit = defineEmits<{
        focus: [];
        dismiss: [];
        clearSession: [];
        openSettings: [];
        togglePin: [];
        toggleMaximize: [];
        'pin-change': [value: boolean];
        'maximize-toggle': [];
        'new-session': [];
        'history-open-change': [payload: { open: boolean; anchorElement: HTMLElement | null }];
        'history-prefetch': [anchorElement: HTMLElement | null];
        'drag-start': [];
        'drag-end': [];
        regenerateMessage: [messageId: string];
        latestContentVisibilityChange: [visible: boolean];
    }>();

    const conversationContainer = ref<HTMLElement | null>(null);

    const conversationContainerStyle = computed(() => ({
        maxHeight: props.fillAvailableHeight ? 'none' : `${props.maxHeight}px`,
        overflowY: 'auto' as const,
    }));

    function isLatestContentVisible(): boolean {
        if (!conversationContainer.value) return false;
        return isScrolledToBottom(conversationContainer.value);
    }

    function emitLatestContentVisibility() {
        // 如果容器已经被隐藏，则不应该触发可见性变化事件，保持原有状态即可
        // 这样可以防止窗口隐藏瞬间，因 clientHeight=0 导致的 `isLatestContentVisible()` 结果突变为 false 并触发 emit
        if (!conversationContainer.value || conversationContainer.value.clientHeight === 0) {
            return;
        }
        emit('latestContentVisibilityChange', isLatestContentVisible());
    }

    // 检查是否滚动到底部
    function isScrolledToBottom(container: HTMLElement | null): boolean {
        if (!container) return false;
        const { scrollTop, scrollHeight, clientHeight } = container;

        // 当容器被隐藏或无高度时，不可能看到底部
        if (clientHeight === 0 || scrollHeight === 0) {
            return false;
        }

        // 允许 5px 的误差
        return scrollHeight - scrollTop - clientHeight < 5;
    }

    // 检查是否有滚动条
    function hasScrollbar(): boolean {
        if (!conversationContainer.value) return false;
        return conversationContainer.value.scrollHeight > conversationContainer.value.clientHeight;
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

        emitLatestContentVisibility();
    }

    function syncToBottom() {
        if (!conversationContainer.value) return;
        lastAutoScrollAt.value = Date.now();
        conversationContainer.value.scrollTop = conversationContainer.value.scrollHeight;
        lastScrollTop.value = conversationContainer.value.scrollTop;

        emitLatestContentVisibility();
    }

    function smoothScrollToBottom() {
        if (!conversationContainer.value) return;
        lastAutoScrollAt.value = Date.now();
        conversationContainer.value.scrollTo({
            top: conversationContainer.value.scrollHeight,
            behavior: 'smooth',
        });
        lastScrollTop.value = conversationContainer.value.scrollTop;

        emitLatestContentVisibility();
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

    function markUserScrollIntent() {
        lastUserScrollIntentAt.value = Date.now();
    }

    function handleScrollIntentByKeyboard(e: KeyboardEvent) {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
            markUserScrollIntent();
        }
    }

    function handleTimelineJump(messageId: string) {
        const element = conversationContainer.value?.querySelector(
            `[data-message-id="${messageId}"]`
        );
        if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'start' });
            markUserScrollIntent();
        }
    }

    function handleRegenerateMessage(messageId: string) {
        emit('regenerateMessage', messageId);
    }

    function scrollToBottom() {
        smoothScrollToBottom();
    }

    function getHistoryAnchor() {
        return null;
    }

    const messageListRef = ref<HTMLElement | null>(null);
    const timelineRef = ref<InstanceType<typeof ConversationTimeline> | null>(null);
    let messageListObserver: ResizeObserver | null = null;

    // TODO: refactor auto scroll logic to be more robust
    const showScrollToBottom = ref(false);
    const isAutoScrollEnabled = ref(true);
    const lastScrollTop = ref(0);
    const lastUserScrollIntentAt = ref(0);
    const lastAutoScrollAt = ref(0);

    const scrollHeight = ref(0);
    const clientHeight = ref(0);
    const scrollTop = ref(0);

    const settingsStore = useSettingsStore();
    const outputScrollBehavior = computed(() => settingsStore.settings.outputScrollBehavior);

    function focus() {
        conversationContainer.value?.focus();
    }

    function togglePin() {
        emit('togglePin');
        emit('pin-change', !props.isPinned);
    }

    function toggleMaximize() {
        emit('toggleMaximize');
        emit('maximize-toggle');
    }

    function clearSession() {
        emit('clearSession');
        emit('new-session');
    }

    function revealLatestContent() {
        if (!conversationContainer.value) return;

        // 如果用户往上滑了（未读完），就让滚动条滚动到底部
        if (!isScrolledToBottom(conversationContainer.value)) {
            smoothScrollToBottom();
            return;
        }

        // 如果已经在底部，或者设置了跟随输出，就在 timeline 里做展示逻辑
        timelineRef.value?.scrollToBottom();
    }

    function scrollByDelta(deltaY: number) {
        if (!conversationContainer.value) return;
        conversationContainer.value.scrollTop += deltaY;
        handleScroll();
    }

    // 监听消息列表高度变化，用于自动滚动
    onMounted(() => {
        if (messageListRef.value) {
            messageListObserver = new ResizeObserver(() => {
                if (isAutoScrollEnabled.value && !props.historyOpen) {
                    syncToBottom();
                }
                refreshScrollToBottomVisibility();
            });
            messageListObserver.observe(messageListRef.value);
        }

        // 初始化滚动条状态
        nextTick(() => {
            refreshScrollToBottomVisibility();
        });
    });

    onUnmounted(() => {
        if (messageListObserver) {
            messageListObserver.disconnect();
        }
    });

    // 暴露方法给父组件
    defineExpose({
        focus,
        togglePin,
        toggleMaximize,
        clearSession,
        revealLatestContent,
        scrollByDelta,
        getHistoryAnchor,
        isLatestContentVisible,
    });
</script>

<style scoped>
    .conversation-container {
        scrollbar-gutter: stable;
        scroll-behavior: auto;
    }

    .scroll-fade-overlay {
        background: linear-gradient(to top, var(--background-primary) 0%, transparent 100%);
    }
</style>
