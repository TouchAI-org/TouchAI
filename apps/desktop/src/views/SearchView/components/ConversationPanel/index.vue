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
            @state-change="handleScrollerStateChange"
        >
            <template #virtualized>
                <!--
                    必须等拿到滚动视口再渲染：virtua 在首次渲染时绑定 `scrollRef`，
                    拿不到就会退回用父元素（不可滚动），从而把整段消息都当成“可见”全量挂载。
                -->
                <Virtualizer
                    v-if="scrollViewport"
                    ref="messageVirtualizer"
                    :data="messages"
                    :scroll-ref="scrollViewport"
                    :item-size="320"
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
    import { storeToRefs } from 'pinia';
    import { Virtualizer, type VirtualizerHandle } from 'virtua/vue';
    import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

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
    let resizeSyncFrame: number | null = null;
    let pinFrame: number | null = null;
    const conversationToolbar = ref<{
        getHistoryAnchor: () => HTMLElement | null;
    } | null>(null);
    const settingsStore = useSettingsStore();
    const { outputScrollBehavior } = storeToRefs(settingsStore);
    const showScrollToBottom = ref(false);
    const USER_MESSAGE_SCROLL_GAP = 12;
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

    function focus() {
        conversationScroller.value?.focus();
    }

    function revealLatestContent() {
        conversationScroller.value?.scrollToEnd('auto');
        showScrollToBottom.value = false;
        pinToEndUntilSettled();
    }

    /**
     * 打开或切换会话时把视图钉到底部，直到真的到底或次数用完。
     *
     * 虚拟列表的未知高度是估算值：首帧 `scrollToEnd` 时 `scrollHeight` 还很小，
     * 条目挂载后高度一次跳到真实值，此时 scroller 的测量会把“离底很远”当成
     * 用户上滚并关掉跟随，于是整个会话停在顶部。这里按帧重试几次，
     * 一旦到底立即停止，因此不会和用户抢滚动。
     */
    function pinToEndUntilSettled(attempts = 10): void {
        if (pinFrame !== null) {
            return;
        }

        const step = () => {
            pinFrame = null;
            const state = conversationScroller.value?.getState();
            if (!state || state.atEnd || attempts <= 0) {
                return;
            }

            attempts -= 1;
            conversationScroller.value?.scrollToEnd('auto');
            pinFrame = requestAnimationFrame(step);
        };

        pinFrame = requestAnimationFrame(step);
    }

    function scrollByDelta(deltaY: number) {
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

    function handleScrollerStateChange(state?: MessageScrollerState) {
        // virtua 的 scroll/resize 回调不带状态，这里统一读容器状态。
        const next = state ?? conversationScroller.value?.getState();
        showScrollToBottom.value = Boolean(next?.overflowing && !next?.atEnd);
        emitLatestContentVisibility();
    }

    /** virtua 的 scroll 回调只给偏移量，状态统一从容器读。 */
    function handleVirtualScroll() {
        handleScrollerStateChange();
    }

    /**
     * 虚拟列表视口/条目尺寸变化：
     * 跟随中则贴底；否则只刷新按钮。已到底时直接返回，避免
     * `scrollToEnd -> 重新测量 -> resize` 的循环。
     */
    function handleVirtualResize() {
        if (resizeSyncFrame !== null) {
            return;
        }

        resizeSyncFrame = requestAnimationFrame(() => {
            resizeSyncFrame = null;
            const state = conversationScroller.value?.getState();
            if (!state) {
                return;
            }

            if (state.following && !state.atEnd) {
                conversationScroller.value?.scrollToEnd('auto');
                return;
            }

            handleScrollerStateChange(state);
        });
    }

    /**
     * 按索引跳转（消息可能未挂载，不能用 DOM 查询）。
     *
     * @param messageId 目标消息 id。
     * @param options 对齐与偏移；与 `MessageScroller` 的语义保持一致。
     * @returns 是否已定位。
     */
    function scrollToMessageById(
        messageId: string,
        options: MessageScrollerScrollOptions = {}
    ): boolean {
        const virtualizer = messageVirtualizer.value;
        const index = props.messages.findIndex((message) => message.id === messageId);
        if (!virtualizer || index < 0) {
            return false;
        }

        virtualizer.scrollToIndex(index, {
            align: options.align ?? 'center',
            offset: options.offset ?? 0,
        });
        return true;
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
        conversationScroller.value?.scrollToEnd('smooth');
        showScrollToBottom.value = false;
    }

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

            const appendedMessages = props.messages.slice(oldLength, newLength);
            const latestAppendedUserMessage = [...appendedMessages]
                .reverse()
                .find((message) => message.role === 'user');

            await nextTick();

            if (outputScrollBehavior.value === 'follow_output') {
                if (latestAppendedUserMessage) {
                    conversationScroller.value?.scrollToEnd('auto');
                    showScrollToBottom.value = false;
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
        if (pinFrame !== null) {
            cancelAnimationFrame(pinFrame);
            pinFrame = null;
        }
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
