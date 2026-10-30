<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div class="relative w-full" :class="props.fillAvailableHeight ? 'h-full min-h-0' : ''">
        <ConversationToolbar
            ref="conversationToolbar"
            :is-pinned="isPinned"
            :is-maximized="isMaximized"
            :can-pin="messages.length > 0"
            :disabled="toolbarDisabled"
            :history-open="historyOpen"
            @pin-change="emit('pinChange', $event)"
            @maximize-toggle="emit('maximizeToggle')"
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
            class="conversation-container min-h-0 w-full overflow-y-auto bg-background-primary px-10 pt-[4.5rem] pb-5 focus:outline-none"
            :class="props.fillAvailableHeight ? 'h-full' : ''"
            :style="conversationContainerStyle"
            @scroll="handleScroll"
            @wheel.passive="markUserScrollIntent"
            @pointerdown="markUserScrollIntent"
            @touchstart.passive="markUserScrollIntent"
            @keydown="handleScrollIntentByKeyboard"
        >
            <!-- 消息列表：虚拟滚动由 virtua 负责测量与锦点，打开时直接定位到底部 -->
            <Virtualizer
                ref="messageVirtualizer"
                :data="messages"
                :scroll-ref="conversationContainer || undefined"
                :item-size="320"
                :start-margin="16"
                :class="isListPositioned ? '' : 'invisible'"
                @scroll="handleScroll"
                @resize="handleVirtualResize"
            >
                <template #default="{ item }">
                    <div :data-message-id="item.id" :data-message-role="item.role">
                        <MessageItem :message="item" @regenerate="handleRegenerateMessage" />
                    </div>
                </template>
            </Virtualizer>

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
        <Transition name="t-fade">
            <div
                v-if="showScrollToBottom"
                class="scroll-fade-overlay pointer-events-none absolute right-0 bottom-0 left-0 flex h-20 items-end justify-center rounded-lg pb-4"
            >
                <button
                    class="t-press pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full bg-white shadow-lg hover:bg-gray-50 hover:shadow-xl"
                    @click="scrollToBottom"
                >
                    <AppIcon name="arrow-down" class="h-4 w-4 text-gray-600" />
                </button>
            </div>
        </Transition>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { MARKDOWN_SCROLL_ROOT_KEY } from '@components/markdownScrollRoot';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import { storeToRefs } from 'pinia';
    import { Virtualizer, type VirtualizerHandle } from 'virtua/vue';
    import { computed, nextTick, onMounted, provide, ref, watch } from 'vue';

    import { useSettingsStore } from '@/stores/settings';
    import type { SessionMessage } from '@/types/session';

    import ConversationTimeline from './components/ConversationTimeline.vue';
    import ConversationToolbar from './components/ConversationToolbar.vue';
    import MessageItem from './components/MessageItem.vue';
    import { resolveFollowScrollState } from './followScrollState';
    import { classifyMessageListChange } from './messageListChange';
    import { buildMessageListRevision } from './messageListRevision';

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
        regenerateMessage: [messageId: string];
        pinChange: [isPinned: boolean];
        maximizeToggle: [];
        newSession: [];
        historyOpenChange: [payload: { open: boolean; anchorElement: HTMLElement | null }];
        historyPrefetch: [anchorElement: HTMLElement | null];
        dragStart: [];
        dragEnd: [];
        latestContentVisibilityChange: [visible: boolean];
    }>();

    const conversationContainer = ref<HTMLElement | null>(null);
    // 会话内 Markdown 渲染器共享同一个外层滚动 owner，避免各自猜测滚动根。
    provide(MARKDOWN_SCROLL_ROOT_KEY, () => conversationContainer.value);
    const conversationToolbar = ref<{
        getHistoryAnchor: () => HTMLElement | null;
    } | null>(null);
    const messageVirtualizer = ref<VirtualizerHandle | null>(null);
    let resizeSyncFrame: number | null = null;
    // 首屏先隐藏列表，等定位到底后再显示，否则会先闪一下顶部。
    const isListPositioned = ref(true);
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

    // 时间轴相关状态
    const scrollTop = ref(0);
    const scrollHeight = ref(0);
    const clientHeight = ref(0);

    const conversationContainerStyle = computed(() =>
        props.fillAvailableHeight
            ? {
                  height: '100%',
                  maxHeight: 'none',
              }
            : {
                  height: 'auto',
                  maxHeight: `${props.maxHeight}px`,
              }
    );

    // 暴露 focus 方法
    function focus() {
        conversationContainer.value?.focus();
    }

    /**
     * 切换历史会话时直接定位到最底部。
     *
     * 用虚拟滚动的 `scrollToIndex` 而不是 `scrollTop = scrollHeight`：
     * 后者在未测量完之前会落在中间，用户会看到内容从顶部往下“滚过去”。
     */
    function revealLatestContent() {
        isAutoScrollEnabled.value = outputScrollBehavior.value === 'follow_output';
        showScrollToBottom.value = false;
        syncToBottom();
        // 首帧测量完成后校正一次，避免“先到估值底部再跳”的视觉跳动。
        requestAnimationFrame(() => {
            syncToBottom();
        });
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

    function isLatestContentVisible() {
        return isScrolledToBottom(conversationContainer.value);
    }

    defineExpose({
        focus,
        revealLatestContent,
        scrollByDelta,
        getHistoryAnchor,
        isLatestContentVisible,
    });

    function emitLatestContentVisibility() {
        emit('latestContentVisibilityChange', isLatestContentVisible());
    }

    function handleRegenerateMessage(messageId: string) {
        emit('regenerateMessage', messageId);
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

    /**
     * 同步容器滚动指标到 ref。
     *
     * 程序性滚动（跟随输出、时间轴跳转）后 scroll 事件派发前，窗口化仍会用旧
     * scrollTop 算渲染区间，导致刚滚到的消息晚一拍才挂载。
     */
    function syncScrollMetrics() {
        const container = conversationContainer.value;
        if (!container) {
            return;
        }

        if (scrollTop.value !== container.scrollTop) {
            scrollTop.value = container.scrollTop;
        }
        if (scrollHeight.value !== container.scrollHeight) {
            scrollHeight.value = container.scrollHeight;
        }
        if (clientHeight.value !== container.clientHeight) {
            clientHeight.value = container.clientHeight;
        }
    }

    // 处理容器滚动事件
    function handleScroll() {
        if (!conversationContainer.value) return;

        const container = conversationContainer.value;
        const currentScrollTop = container.scrollTop;
        const atBottom = isScrolledToBottom(container);
        const mode = outputScrollBehavior.value;

        syncScrollMetrics();

        const now = Date.now();
        // 程序性滚动（自动跟随、时间轴跳转、窗口化高度补偿）不能用来切换跟随状态。
        const isProgrammaticScroll = now - lastAutoScrollAt.value < 180;
        const hasRecentUserIntent = now - lastUserScrollIntentAt.value < 800;

        const followState = resolveFollowScrollState({
            mode,
            atBottom,
            hasScrollbar: hasScrollbar(),
            scrolledUp: currentScrollTop < lastScrollTop.value - 1,
            isProgrammatic: isProgrammaticScroll,
            hasRecentUserIntent,
            isFollowing: isAutoScrollEnabled.value,
        });
        isAutoScrollEnabled.value = followState.isFollowing;
        showScrollToBottom.value = followState.showScrollToBottom;

        lastScrollTop.value = currentScrollTop;
        emitLatestContentVisibility();
    }

    /** 滚到最后一条消息（虚拟滚动自带测量与铺底，不靠 scrollHeight 估算）。 */
    function syncToBottom() {
        const lastIndex = props.messages.length - 1;
        if (lastIndex < 0) {
            return;
        }

        lastAutoScrollAt.value = Date.now();
        messageVirtualizer.value?.scrollToIndex(lastIndex, { align: 'end' });
        lastScrollTop.value = conversationContainer.value?.scrollTop ?? 0;
        syncScrollMetrics();
        emitLatestContentVisibility();
    }

    function smoothScrollToBottom() {
        const lastIndex = props.messages.length - 1;
        if (lastIndex < 0) {
            return;
        }

        lastAutoScrollAt.value = Date.now();
        messageVirtualizer.value?.scrollToIndex(lastIndex, { align: 'end', smooth: true });
        lastScrollTop.value = conversationContainer.value?.scrollTop ?? 0;
        syncScrollMetrics();
        emitLatestContentVisibility();
    }

    /** 虚拟滚动视口/条目尺寸变化：跟随中则贴底。
     *
     * 这里必须闸一下：`scrollToIndex` 会触发重新测量 → 再次 onResize，
     * 重消息场景下会反复几百毫秒。已经到底时直接返回即可断掉这个环。
     */
    function handleVirtualResize() {
        syncScrollMetrics();

        if (resizeSyncFrame !== null) {
            return;
        }

        resizeSyncFrame = requestAnimationFrame(() => {
            resizeSyncFrame = null;

            if (!shouldAutoScrollOnOutput()) {
                refreshScrollToBottomVisibility();
                return;
            }

            if (isScrolledToBottom(conversationContainer.value)) {
                return;
            }

            syncToBottom();
        });
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
        emitLatestContentVisibility();
    }

    /**
     * 滚到指定消息顶部。
     *
     * 交给虚拟滚动的 `scrollToIndex`：未测量的条目先按估值跳过去，
     * 测量完成后由库自己校正，不会出现手写方案那种“来回滚动还落错位置”。
     *
     * @returns 是否已定位（找不到消息时返回 false）。
     */
    function scrollToUserMessageTop(messageId: string, gap = USER_MESSAGE_SCROLL_GAP): boolean {
        const virtualizer = messageVirtualizer.value;
        const index = props.messages.findIndex((message) => message.id === messageId);
        if (!virtualizer || index < 0) {
            return false;
        }

        lastAutoScrollAt.value = Date.now();
        virtualizer.scrollToIndex(index, { align: 'start', offset: -gap });
        lastScrollTop.value = conversationContainer.value?.scrollTop ?? 0;
        syncScrollMetrics();
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
        emitLatestContentVisibility();
    }

    // 滚动到底部
    function scrollToBottom() {
        smoothScrollToBottom();
        isAutoScrollEnabled.value = outputScrollBehavior.value === 'follow_output';
        showScrollToBottom.value = false;
    }

    // 当消息变化时自动滚动到底部（仅在启用自动滚动时）
    // 只跟随列表尾部 revision，避免每个流式快照都对全历史做深度遍历。
    watch(
        () => buildMessageListRevision(props.messages),
        async () => {
            if (!shouldAutoScrollOnOutput()) return;

            await nextTick();
            syncToBottom();
        }
    );

    /**
     * 切换到某个会话时的首屏定位。
     *
     * 先隐藏列表（保留布局供测量）→ 定位到底 → 一帧后校正 → 显示，
     * 避免“先看到顶部再滑到底”的闪烁。
     */
    function positionListAtBottom() {
        isListPositioned.value = false;
        void nextTick(() => {
            syncToBottom();
            requestAnimationFrame(() => {
                syncToBottom();
                isListPositioned.value = true;
            });
        });
    }
    // 重置自动滚动状态
    watch(
        () => props.messages.map((message) => message.id),
        (nextIds, previousIds) => {
            const change = classifyMessageListChange(previousIds ?? [], nextIds);

            // 消息被清空（新请求开始）
            if (change === 'clear') {
                isAutoScrollEnabled.value = outputScrollBehavior.value === 'follow_output';
                showScrollToBottom.value = false;
                lastScrollTop.value = 0;
                return;
            }

            // 只有尾部追加才可能代表新一轮提问；
            // 向顶部加载历史页（prepend）不能改变跟随状态，否则刚上滚的视图会被拉回底部。
            if (change !== 'append') {
                if (change === 'replace') {
                    // 整表替换 = 切换到了另一个会话。
                    positionListAtBottom();
                }
                return;
            }

            const appendedMessages = props.messages.slice(previousIds?.length ?? 0);
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
                        refreshScrollToBottomVisibility();
                        return;
                    }
                    refreshScrollToBottomVisibility();
                });
            } else {
                isAutoScrollEnabled.value = false;
                nextTick(() => {
                    refreshScrollToBottomVisibility();
                    emitLatestContentVisibility();
                });
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
            emitLatestContentVisibility();
        },
        { immediate: true }
    );

    onMounted(async () => {
        await settingsStore.initialize();

        // 初始化时间轴滚动状态
        syncScrollMetrics();
        emitLatestContentVisibility();

        // 首次挂载时消息可能已经就绪（面板晚于会话数据挂载），
        // 这时没有 watcher 可依赖，必须在这里主动定位到底部。
        if (props.messages.length > 0) {
            positionListAtBottom();
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
