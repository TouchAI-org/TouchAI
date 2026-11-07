<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div
        class="relative w-full"
        :class="props.fillAvailableHeight ? 'h-full min-h-0' : ''"
        @wheel.capture.passive="cancelNavigation"
        @touchstart.capture.passive="cancelNavigation"
        @pointerdown.capture="cancelNavigation"
        @keydown.capture="handleNavigationKeydown"
    >
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

        <MessageScroller
            ref="conversationScroller"
            :items="messageRailItems"
            :follow-output="outputScrollBehavior === 'follow_output'"
            :follow-threshold="56"
            :smooth="false"
            :busy="isLoading"
            navigation="rail"
            :label="t('conversation.scroller.label')"
            :navigation-label="t('conversation.scroller.navigation')"
            :empty-label="t('conversation.scroller.message')"
            :class="props.fillAvailableHeight ? 'h-full' : ''"
            viewport-class="bg-background-primary px-10 pt-18 pb-5"
            content-class="mt-4"
            :viewport-style="conversationContainerStyle"
            :item-scroll-target="scrollToMessageById"
            :item-ranges="railItemRange"
            :rail-inset-top="RAIL_INSET_TOP"
            @follow-change="handleFollowChange"
            @state-change="handleScrollerStateChange"
        >
            <template #virtualized>
                <!-- Short conversations do not need windowing. -->
                <div
                    v-for="message in messagesWithoutVirtualization"
                    :key="message.id"
                    :data-message-id="message.id"
                    :data-message-role="message.role"
                    :data-message-scroller-item="message.id"
                >
                    <MessageItem :message="message" @regenerate="handleRegenerateMessage" />
                </div>

                <!--
                    必须等拿到滚动视口再渲染：virtua 在首次渲染时绑定 `scrollRef`，
                    拿不到就会退回用父元素（不可滚动），从而把整段消息都当成“可见”全量挂载。
                -->
                <Virtualizer
                    v-if="virtualizeMessages && scrollViewport"
                    ref="messageVirtualizer"
                    :data="messages"
                    :scroll-ref="scrollViewport"
                    :item-size="estimatedItemSize"
                    :buffer-size="virtualBufferSize"
                    :keep-mounted="navigationMountedIndexes"
                    @scroll="handleVirtualScroll"
                    @resize="handleVirtualResize"
                >
                    <template #default="{ item }">
                        <div
                            :data-message-id="item.id"
                            :data-message-role="item.role"
                            :data-message-scroller-item="item.id"
                        >
                            <MessageItem :message="item" @regenerate="handleRegenerateMessage" />
                        </div>
                    </template>
                </Virtualizer>
            </template>
        </MessageScroller>

        <Transition name="t-fade">
            <div
                v-if="showScrollToBottom"
                class="scroll-fade-overlay pointer-events-none absolute right-0 bottom-0 left-0 flex h-20 items-end justify-center rounded-lg pb-4"
            >
                <button
                    type="button"
                    class="t-press pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border-subtle bg-surface-raised text-text-secondary shadow-lg hover:bg-surface-hover hover:shadow-xl"
                    :aria-label="t('conversation.scroller.scrollToBottom')"
                    @click="scrollToBottom"
                >
                    <AppIcon name="arrow-down" class="h-4 w-4" />
                </button>
            </div>
        </Transition>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { MARKDOWN_SCROLL_ROOT_KEY } from '@components/markdownScrollRoot';
    import { storeToRefs } from 'pinia';
    import { Virtualizer, type VirtualizerHandle } from 'virtua/vue';
    import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue';

    import {
        MessageScroller,
        type MessageScrollerHandle,
        type MessageScrollerItem,
        type MessageScrollerScrollOptions,
        type MessageScrollerState,
    } from '@/components/ui/message-scroller';
    import { t } from '@/i18n';
    import { useSettingsStore } from '@/stores/settings';
    import type { SessionMessage } from '@/types/session';

    import ConversationToolbar from './components/ConversationToolbar.vue';
    import MessageItem from './components/MessageItem.vue';
    import { estimateMessageListItemSize } from './messageHeightEstimate';
    import {
        type NavigationTarget,
        resolveDesiredOffset,
        resolveNavigationCorrection,
    } from './navigationAnchor';

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

    const conversationScroller = ref<MessageScrollerHandle | null>(null);
    const messageVirtualizer = ref<VirtualizerHandle | null>(null);
    const scrollViewport = ref<HTMLElement | null>(null);
    provide(MARKDOWN_SCROLL_ROOT_KEY, () => scrollViewport.value);
    /**
     * 是否启用消息虚拟化。
     *
     * 只有消息太少（成本本来就不高）才关掉；其余都保留虚拟化。
     * 之前“单条很高就不虚拟”的判据已经不说：真正的毛病是估算高度固定成 320px，
     * 与实测差十几倍才导致 virtua 反复大幅补偿。现在 `item-size` 用内容估算的中位数，
     * 误差已降到个位数，长回答会话也能稳定虚拟化。
     */
    const VIRTUALIZATION_MIN_MESSAGES = 12;
    const virtualizeMessages = computed(() => props.messages.length >= VIRTUALIZATION_MIN_MESSAGES);

    /** 不虚拟化时直接渲染全部消息。 */
    const messagesWithoutVirtualization = computed(() =>
        virtualizeMessages.value ? [] : props.messages
    );

    /** 条目高度提示：取估算中位数（参照 Cherry Studio 用 estimateSize 做滚动预算）。 */
    const estimatedItemSize = computed(() => estimateMessageListItemSize(props.messages));

    // Overscan must stay bounded even when one answer spans many screens.
    const virtualBufferSize = computed(() => Math.max(200, props.maxHeight));
    /** scroller 的跟随意图镜像：内容变高会把它的内部判定改成“已上滚”，这里保留原意图。 */
    const isFollowing = ref(true);
    let resizeSyncFrame: number | null = null;
    let pinFrame: number | null = null;
    const navigationTarget = ref<NavigationTarget | null>(null);
    const navigationMountedIndexes = computed(() => {
        const index = props.messages.findIndex(
            (message) => message.id === navigationTarget.value?.id
        );
        return index < 0 ? [] : [index];
    });
    let navigationMeasurePending = false;

    const conversationToolbar = ref<{
        getHistoryAnchor: () => HTMLElement | null;
    } | null>(null);
    const settingsStore = useSettingsStore();
    const { outputScrollBehavior } = storeToRefs(settingsStore);
    const showScrollToBottom = ref(false);
    const USER_MESSAGE_SCROLL_GAP = 12;
    /**
     * 导航轨顶部要避开的拖动区高度。
     *
     * 工具栏（含窗口拖动区）高 4.5rem 且 z-index 在内容之上；轨道若从容器顶部开始，
     * 最上面几个点会落在拖动区里，表现为“只能拖动、点不到”。
     */
    const RAIL_INSET_TOP = 72 + 8;
    const RAIL_PREVIEW_SOURCE_LENGTH = 320;

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

    function normaliseMessageText(content: string): string {
        return content.slice(0, RAIL_PREVIEW_SOURCE_LENGTH).replace(/\s+/g, ' ').trim();
    }

    function roleLabel(role: SessionMessage['role']): string {
        return role === 'user'
            ? t('conversation.scroller.user')
            : t('conversation.scroller.assistant');
    }

    const messageRailItems = computed<MessageScrollerItem[]>(() => {
        const turns: MessageScrollerItem[] = [];
        let currentTurn: MessageScrollerItem | undefined;
        let currentTurnHasAssistant = false;

        for (const message of props.messages) {
            if (message.role === 'user') {
                currentTurn = {
                    id: message.id,
                    label:
                        normaliseMessageText(message.content) || t('conversation.scroller.message'),
                    role: message.role,
                };
                turns.push(currentTurn);
                currentTurnHasAssistant = false;
                continue;
            }

            if (message.role === 'assistant' && currentTurn && !currentTurnHasAssistant) {
                currentTurn.description = normaliseMessageText(message.content) || undefined;
                currentTurnHasAssistant = true;
            }
        }

        return turns.map((item, turnIndex) => ({
            ...item,
            ariaLabel: t('conversation.scroller.jumpToMessage', {
                role: roleLabel('user'),
                index: turnIndex + 1,
                total: turns.length,
            }),
        }));
    });

    /** 每个 turn（用户提问 + 其后的回答）覆盖的消息 id 区间。 */
    const turnMessageIds = computed<Map<string, string[]>>(() => {
        const turns = new Map<string, string[]>();
        let currentIds: string[] | undefined;
        for (const message of props.messages) {
            if (message.role === 'user') {
                currentIds = [message.id];
                turns.set(message.id, currentIds);
                continue;
            }

            currentIds?.push(message.id);
        }

        return turns;
    });

    /**
     * 某条轨道项在内容坐标系中的区间。
     *
     * 一整个 turn（提问 + 长回答）往往跨很多屏，所以高亮必须按区间判断重叠；
     * 只按“视图中心最近的那条消息”会把回答占的多屏算成别人的位置。
     * 虚拟列表无法给未挂载消息量 DOM，直接用 virtua 的累计偏移。
     */
    function railItemRange(itemId: string): { top: number; bottom: number } | null {
        const ids = turnMessageIds.value.get(itemId);
        const virtualizer = messageVirtualizer.value;
        if (!ids?.length || !virtualizer) {
            return null;
        }

        const indexOf = (id: string) => props.messages.findIndex((message) => message.id === id);
        const firstIndex = indexOf(ids[0]!);
        const lastIndex = indexOf(ids[ids.length - 1]!);
        if (firstIndex < 0 || lastIndex < 0) {
            return null;
        }

        /**
         * virtua 的偏移相对“列表起点”，而轨道比较用的是容器 `scrollTop`。
         * 两者相差容器内边距与列表外边距，用 `scrollTop - scrollOffset` 补回基准。
         */
        const base = (scrollViewport.value?.scrollTop ?? 0) - (virtualizer.scrollOffset ?? 0);
        const top = base + virtualizer.getItemOffset(firstIndex);
        const bottom =
            base + virtualizer.getItemOffset(lastIndex) + virtualizer.getItemSize(lastIndex);

        return { top, bottom };
    }

    function focus() {
        conversationScroller.value?.focus();
    }

    function revealLatestContent() {
        cancelNavigation();
        conversationScroller.value?.scrollToEnd('auto');
        showScrollToBottom.value = false;
        pinToEndUntilSettled();
    }

    /**
     * 打开或切换会话时把视图钉到底部，直到真的到底且安静一段时间。
     *
     * 虚拟列表的未知高度是估算值：首帧 `scrollToEnd` 时 `scrollHeight` 还很小，
     * 条目挂载后高度一次跳到真实值；而代码块库（markstream）会在自己测量完后
     * 再写一次外层 `scrollTop` 做锚定补偿，把我们贴好的底推开十几像素。
     * 所以不能“两帧到底”就收手，要等位置和高度都**安静一段时间**（QUIET_MS）。
     * 到底即停，不会和用户抢滚动。
     */
    function pinToEndUntilSettled(attempts = 180): void {
        if (pinFrame !== null) {
            return;
        }

        // 代码块库（markstream）的锚定恢复可能在我们贴底后 1~2 秒才写一次
        // 外层 scrollTop，所以安静窗口要盖过它；一旦用户自己滚动（isFollowing 转为 false）
        // 立刻退出，不抢滚动。
        const QUIET_MS = 1200;
        let lastScrollHeight = -1;
        let lastScrollTop = -1;
        let quietSince = 0;

        const step = () => {
            pinFrame = null;
            if (!isFollowing.value) {
                return;
            }

            const state = conversationScroller.value?.getState();
            if (!state) {
                return;
            }

            const now = Date.now();
            const changed =
                state.scrollHeight !== lastScrollHeight || state.scrollTop !== lastScrollTop;
            if (changed) {
                lastScrollHeight = state.scrollHeight;
                lastScrollTop = state.scrollTop;
                quietSince = now;
            }

            const quiet = quietSince > 0 && now - quietSince >= QUIET_MS;
            if (state.atEnd && quiet) {
                return;
            }

            // 已到底但还不安静：先等着，不走无意义的写入。
            if (state.atEnd) {
                if (attempts <= 0) {
                    return;
                }
                attempts -= 1;
                pinFrame = requestAnimationFrame(step);
                return;
            }

            if (attempts <= 0) {
                return;
            }

            attempts -= 1;
            conversationScroller.value?.scrollToEnd('auto');
            pinFrame = requestAnimationFrame(step);
        };

        quietSince = Date.now();
        pinFrame = requestAnimationFrame(step);
    }
    function scrollByDelta(deltaY: number) {
        cancelNavigation();
        conversationScroller.value?.scrollBy(deltaY);
    }

    function getHistoryAnchor() {
        return conversationToolbar.value?.getHistoryAnchor() ?? null;
    }

    function isLatestContentVisible() {
        return conversationScroller.value?.isAtEnd() ?? true;
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

    function handleFollowChange(following: boolean) {
        isFollowing.value = following;
        if (following) cancelNavigation();
    }

    function handleScrollerStateChange(state?: MessageScrollerState) {
        // virtua 的 scroll/resize 回调不带状态，这里统一读容器状态。
        const next = state ?? conversationScroller.value?.getState();
        showScrollToBottom.value = Boolean(next?.overflowing && !next?.atEnd);
        emitLatestContentVisibility();
    }

    /** virtua 的 scroll 回调只给偏移量，状态统一从容器读。 */
    function handleVirtualScroll() {
        // scroller 自身会监听同一个滚动事件并测量，这里只同步按钮与对外状态。
        handleScrollerStateChange();
    }

    function handleVirtualResize() {
        scheduleNavigationMeasure();
        if (resizeSyncFrame !== null) {
            return;
        }

        resizeSyncFrame = requestAnimationFrame(() => {
            resizeSyncFrame = null;

            handleScrollerStateChange();
        });
    }

    function scrollToMessageById(
        messageId: string,
        options: MessageScrollerScrollOptions = {}
    ): boolean {
        const index = props.messages.findIndex((message) => message.id === messageId);
        const scroller = scrollViewport.value;
        if (index < 0 || !messageVirtualizer.value || !scroller) {
            return false;
        }

        // 用户主动跳转：放弃“首次打开钉到底”的重试，否则两者会互相抢滚动。
        cancelPinToEnd();

        // 跳到历史位置就是离开实时边缘：关掉跟随，否则 resize / 重测时
        // primitive 会自动贴底，把刚跳到的位置又拽回去（看起来像“往上偏一点”）。
        // 用户滚回底部时 `handleScroll` 会重新打开跟随。
        conversationScroller.value?.setFollowing(false);
        isFollowing.value = false;

        const target: NavigationTarget = {
            id: messageId,
            align: options.align ?? 'center',
            gap: options.offset ?? 0,
        };
        // Mount just the target before moving. scrollToIndex also repositions after
        // measurement, racing virtua's relative resize compensation in the same flush.
        navigationTarget.value = target;
        scheduleNavigationMeasure();

        handleScrollerStateChange();
        return true;
    }

    function scheduleNavigationMeasure(): void {
        if (!navigationTarget.value || navigationMeasurePending) return;
        navigationMeasurePending = true;
        // Let virtua apply its measured offsets and resize compensation before aligning.
        void nextTick(() => {
            navigationMeasurePending = false;
            const target = navigationTarget.value;
            if (target) correctNavigationOnce(target);
        });
    }

    function correctNavigationOnce(target: NavigationTarget): boolean {
        const scroller = scrollViewport.value;
        if (!scroller) {
            return false;
        }

        const element = scroller.querySelector<HTMLElement>(
            `[data-message-id="${cssEscape(target.id)}"]`
        );
        if (!element) {
            return false;
        }

        const containerTop = scroller.getBoundingClientRect().top;
        const rect = element.getBoundingClientRect();
        const desiredOffset = resolveDesiredOffset(
            target.align,
            target.gap,
            rect.height,
            scroller.clientHeight
        );
        const correction = resolveNavigationCorrection(rect.top - containerTop, desiredOffset);
        if (correction === 0) {
            return false;
        }

        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const top = Math.min(maxScrollTop, Math.max(0, scroller.scrollTop + correction));
        if (Math.abs(top - scroller.scrollTop) <= 1) return false;
        scroller.scrollTop = top;
        return true;
    }

    function cancelNavigation(): void {
        navigationTarget.value = null;
    }

    function handleNavigationKeydown(event: KeyboardEvent): void {
        if (
            ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
        ) {
            cancelNavigation();
        }
    }

    function cssEscape(value: string): string {
        return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(value)
            : value;
    }

    function cancelPinToEnd(): void {
        if (pinFrame !== null) {
            cancelAnimationFrame(pinFrame);
            pinFrame = null;
        }
    }

    function refreshScrollToBottomVisibility() {
        const state = conversationScroller.value?.getState();
        showScrollToBottom.value = Boolean(state?.overflowing && !state.atEnd);
        emitLatestContentVisibility();
    }

    function scrollToUserMessageTop(messageId: string, gap = USER_MESSAGE_SCROLL_GAP): boolean {
        return (
            conversationScroller.value?.scrollToItem(messageId, {
                align: 'start',
                offset: gap,
            }) ?? false
        );
    }

    function scrollToBottom() {
        cancelNavigation();
        conversationScroller.value?.scrollToEnd('smooth');
        showScrollToBottom.value = false;
    }

    watch(() => props.messages[0]?.id, cancelNavigation);

    watch(
        () => props.messages.length,
        async (newLength, oldLength) => {
            if (newLength === 0 && oldLength > 0) {
                showScrollToBottom.value = false;
                await nextTick();
                refreshScrollToBottomVisibility();
                return;
            }

            if (newLength <= oldLength) return;

            // 以“追加前是否在底部”为准：`following` 是派生状态，
            // 会在内容变高/程序性滚动时被改写，不能用来判断用户意图。
            const wasAtEnd = conversationScroller.value?.getState().atEnd ?? true;

            const appendedMessages = props.messages.slice(oldLength, newLength);
            const latestAppendedUserMessage = [...appendedMessages]
                .reverse()
                .find((message) => message.role === 'user');

            await nextTick();

            if (outputScrollBehavior.value === 'follow_output') {
                if (latestAppendedUserMessage) {
                    cancelNavigation();
                    conversationScroller.value?.scrollToEnd('auto');
                    pinToEndUntilSettled();
                    showScrollToBottom.value = false;
                } else if (wasAtEnd) {
                    // 用户本来就在底部：新内容把高度顶高后继续贴底。
                    conversationScroller.value?.scrollToEnd('auto');
                    pinToEndUntilSettled();
                } else {
                    refreshScrollToBottomVisibility();
                }
                return;
            }

            if (outputScrollBehavior.value === 'jump_to_top' && latestAppendedUserMessage) {
                scrollToUserMessageTop(latestAppendedUserMessage.id);
            }

            refreshScrollToBottomVisibility();
        }
    );

    watch(
        outputScrollBehavior,
        async (mode) => {
            await nextTick();
            if (mode === 'follow_output') {
                cancelNavigation();
                conversationScroller.value?.scrollToEnd('auto');
                return;
            }
            refreshScrollToBottomVisibility();
        },
        { immediate: true }
    );

    onMounted(async () => {
        await settingsStore.initialize();
        await nextTick();

        // virtua 必须绑定到 scroller 的滚动视口（`section`），
        // 拿不到它会退回父元素，父元素不可滚动，于是“全部可见”而全量挂载。
        scrollViewport.value = conversationScroller.value?.getViewportElement() ?? null;
        if (!scrollViewport.value) {
            await nextTick();
            scrollViewport.value = conversationScroller.value?.getViewportElement() ?? null;
        }

        if (outputScrollBehavior.value === 'follow_output') {
            conversationScroller.value?.scrollToEnd('auto');
            pinToEndUntilSettled();
            return;
        }
        refreshScrollToBottomVisibility();
    });

    onUnmounted(() => {
        cancelPinToEnd();
        cancelNavigation();
        if (resizeSyncFrame !== null) {
            cancelAnimationFrame(resizeSyncFrame);
            resizeSyncFrame = null;
        }
    });
</script>

<style scoped>
    .scroll-fade-overlay {
        background: linear-gradient(to bottom, transparent 0%, var(--color-overlay-fade) 100%);
    }
</style>
