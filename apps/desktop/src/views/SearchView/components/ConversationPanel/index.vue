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
            <!-- 消息列表 -->
            <div ref="messageListRef" class="mt-4">
                <div
                    v-if="windowingEnabled && windowRange.topSpacer > 0"
                    class="w-full"
                    :style="{ height: `${windowRange.topSpacer}px` }"
                    aria-hidden="true"
                />
                <div
                    v-for="message in renderedMessages"
                    :key="message.id"
                    :ref="(el) => setMessageElement(message, el)"
                    :data-message-id="message.id"
                    :data-message-role="message.role"
                >
                    <MessageItem :message="message" @regenerate="handleRegenerateMessage" />
                </div>
                <div
                    v-if="windowingEnabled && windowRange.bottomSpacer > 0"
                    class="w-full"
                    :style="{ height: `${windowRange.bottomSpacer}px` }"
                    aria-hidden="true"
                />
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
    import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue';

    import { useSettingsStore } from '@/stores/settings';
    import type { SessionMessage } from '@/types/session';

    import ConversationTimeline from './components/ConversationTimeline.vue';
    import ConversationToolbar from './components/ConversationToolbar.vue';
    import MessageItem from './components/MessageItem.vue';
    import { useMessageWindowing } from './composables/useMessageWindowing';
    import { resolveFollowScrollState } from './followScrollState';
    import { estimateMessageHeight } from './messageHeightEstimate';
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

    // 长会话只挂载视口附近的消息，避免 DOM 数量与会话总长度线性增长。
    // 门槛刻意保守：小会话不进入窗口化，避免与 widget/图片等异步测量互相扰动。
    const WINDOWING_MIN_MESSAGES = 40;
    const WINDOWING_MIN_PARTS = 24;

    /**
     * 是否启用有界挂载。
     *
     * 只看消息数不够：一个 assistant 消息里可能带几十个工具调用（每条 10KB+ 输出），
     * 消息数很少也可能一次挂载上千个部件，所以同时看部件数。
     */
    const windowingEnabled = computed(() => {
        const messages = props.messages;
        if (messages.length > WINDOWING_MIN_MESSAGES) {
            return true;
        }

        let parts = 0;
        for (const message of messages) {
            parts += message.parts?.length ?? 0;
            if (parts > WINDOWING_MIN_PARTS) {
                return true;
            }
        }

        return false;
    });
    const {
        windowRange,
        renderedMessages,
        registerMessageElement,
        messageOffsetTop,
        pinMessage,
        releasePin,
    } = useMessageWindowing({
        container: conversationContainer,
        messages: computed(() => props.messages),
        enabled: windowingEnabled,
        scrollTop,
        clientHeight,
        estimateHeight: estimateMessageHeight,
        // 布局补偿产生的滚动不是用户意图，不能据此切换自动跟随。
        onProgrammaticScroll: () => {
            lastAutoScrollAt.value = Date.now();
        },
    });

    function setMessageElement(
        message: SessionMessage,
        target: Element | { $el?: Element } | null
    ) {
        registerMessageElement(message, target);
    }
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
     * 切换历史会话时需要丢弃当前滚动状态，
     * 否则用户手动离底后的偏移会被带到新会话，初始视图会停在最早内容附近。
     */
    function revealLatestContent() {
        syncToBottom();
        // 窗口化下首帧的累计高度还包含估值，测量落地后再对齐一次底部；
        // 否则打开长会话会停在“估值底部”而不是真实底部。
        void nextTick(() => {
            syncToBottom();
        });
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

    function syncToBottom() {
        if (!conversationContainer.value) return;
        lastAutoScrollAt.value = Date.now();
        conversationContainer.value.scrollTop = conversationContainer.value.scrollHeight;
        lastScrollTop.value = conversationContainer.value.scrollTop;
        syncScrollMetrics();
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
        syncScrollMetrics();
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
        emitLatestContentVisibility();
    }

    /** 构造消息节点的属性选择器（转义后避免 id 里的特殊字符破坏选择器）。 */
    function buildMessageSelector(messageId: string): string | null {
        const escaped =
            typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                ? CSS.escape(messageId)
                : messageId;
        return `[data-message-id="${escaped}"]`;
    }

    /**
     * 滚到指定消息顶部。
     *
     * 目标不在有界挂载窗口内时，先把它钉进渲染区间再按真实 DOM 位置定位：
     * 未挂载项只有估算高度，直接按累计估值滚动会越跳越偏（长会话尤其明显）。
     */
    async function scrollToUserMessageTop(
        messageId: string,
        gap = USER_MESSAGE_SCROLL_GAP
    ): Promise<boolean> {
        const container = conversationContainer.value;
        if (!container || !messageListRef.value) {
            return false;
        }

        const selector = buildMessageSelector(messageId);
        let target = selector ? messageListRef.value.querySelector<HTMLElement>(selector) : null;

        if (!target) {
            if (messageOffsetTop(messageId) === null) {
                return false;
            }

            pinMessage(messageId);
            await nextTick();
            target = selector ? messageListRef.value.querySelector<HTMLElement>(selector) : null;
        }

        lastAutoScrollAt.value = Date.now();

        if (target) {
            const containerRect = container.getBoundingClientRect();
            const targetRect = target.getBoundingClientRect();
            const targetScrollTop =
                container.scrollTop + (targetRect.top - containerRect.top) - gap;
            container.scrollTop = Math.max(0, targetScrollTop);
        } else {
            // 极端情况（目标仍未挂载）：退回累计高度估算。
            const offset = messageOffsetTop(messageId);
            if (offset === null) {
                releasePin();
                return false;
            }

            const listTop =
                messageListRef.value.getBoundingClientRect().top -
                container.getBoundingClientRect().top +
                container.scrollTop;
            container.scrollTop = Math.max(0, listTop + offset - gap);
        }

        lastScrollTop.value = container.scrollTop;
        handleScroll();

        // 下一帧再释放：此时窗口已按新的 scrollTop 重算，目标仍在渲染区间内。
        requestAnimationFrame(() => {
            releasePin();
        });
        return true;
    }

    async function handleTimelineJump(messageId: string) {
        const didJump = await scrollToUserMessageTop(
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
     * 开发期埋点：记录一次会话首屏从数据到首帧稳定布局的耗时。
     *
     * 打开长会话卡顿时，这个值与 `[history-open]` 一起能区分是「取数」还是「渲染」。
     */
    function logFirstRenderCost(messageCount: number) {
        const startedAt = performance.now();
        void nextTick(() => {
            requestAnimationFrame(() => {
                console.warn('[chat-render]', {
                    messages: messageCount,
                    mounted: renderedMessages.value.length,
                    ms: Math.round(performance.now() - startedAt),
                });
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
                if (change === 'replace' && import.meta.env.DEV) {
                    logFirstRenderCost(nextIds.length);
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
                        void scrollToUserMessageTop(latestAppendedUserMessage.id).then(() => {
                            refreshScrollToBottomVisibility();
                        });
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
        if (conversationContainer.value) {
            scrollTop.value = conversationContainer.value.scrollTop;
            scrollHeight.value = conversationContainer.value.scrollHeight;
            clientHeight.value = conversationContainer.value.clientHeight;
            emitLatestContentVisibility();
        }

        if (messageListRef.value) {
            messageListObserver = new ResizeObserver(() => {
                if (!shouldAutoScrollOnOutput()) {
                    emitLatestContentVisibility();
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
