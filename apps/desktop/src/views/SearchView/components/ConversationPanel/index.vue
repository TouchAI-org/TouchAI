<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div
        class="relative h-full min-h-0 w-full"
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
            :start-dragging="startDragging"
            @pin-change="emit('pinChange', $event)"
            @maximize-toggle="emit('maximizeToggle')"
            @new-session="emit('newSession')"
            @history-open-change="emit('historyOpenChange', $event)"
            @history-prefetch="emit('historyPrefetch', $event)"
            @wheel="scrollByDelta"
            @drag-start="emit('dragStart')"
            @drag-end="emit('dragEnd')"
        />

        <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {{
                compactionAnnouncement === 'compacting'
                    ? tt('正在压缩上下文')
                    : compactionAnnouncement === 'compacted'
                      ? tt('上下文已压缩')
                      : ''
            }}
        </span>

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
            class="h-full"
            viewport-class="bg-background-primary px-10 pt-22 pb-5"
            content-class="flow-root min-h-0"
            :item-scroll-target="scrollToMessageById"
            :item-ranges="railItemRange"
            :rail-inset-top="80"
            @follow-change="handleFollowChange"
            @state-change="handleScrollerStateChange"
            @content-resize="emit('contentResize', $event)"
        >
            <div
                v-for="message in messagesWithoutVirtualization"
                :key="message.id"
                :data-message-id="message.id"
                :data-message-role="message.role"
                :data-message-scroller-item="message.id"
            >
                <MessageItem :message="message" @regenerate="handleRegenerateMessage" />
            </div>
            <!-- virtua binds scrollRef on mount; wait for the actual scrolling viewport. -->
            <Virtualizer
                v-if="virtualizeMessages && scrollViewport"
                :key="displayMessages[0]?.id"
                ref="messageVirtualizer"
                :data="displayMessages"
                :scroll-ref="scrollViewport"
                :buffer-size="Math.max(200, viewportHeight)"
                :keep-mounted="navigationMountedIndexes"
                @resize="scheduleNavigationMeasure"
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
    import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';

    import {
        MessageScroller,
        type MessageScrollerHandle,
        type MessageScrollerItem,
        type MessageScrollerScrollOptions,
        type MessageScrollerState,
    } from '@/components/ui/message-scroller';
    import { t, tt } from '@/i18n';
    import type { PendingUserMessage } from '@/services/AgentService/task/types';
    import { useSettingsStore } from '@/stores/settings';
    import type { ContextCompactionMessagePart, SessionMessage } from '@/types/session';

    import ConversationToolbar from './components/ConversationToolbar.vue';
    import MessageItem from './components/MessageItem.vue';
    import {
        type NavigationTarget,
        resolveDesiredOffset,
        resolveNavigationCorrection,
    } from './navigationAnchor';
    import { toPendingSessionMessage } from './pendingMessages';

    defineOptions({
        name: 'SearchConversationPanel',
    });

    interface Props {
        messages: SessionMessage[];
        pendingMessages?: PendingUserMessage[];
        isLoading: boolean;
        error: Error | null;
        isPinned: boolean;
        isMaximized?: boolean;
        historyOpen: boolean;
        toolbarDisabled?: boolean;
        startDragging: (event: MouseEvent) => Promise<void>;
    }

    const props = withDefaults(defineProps<Props>(), {
        pendingMessages: () => [],
        toolbarDisabled: false,
        isMaximized: false,
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
        contentResize: [height: number];
    }>();

    const conversationScroller = ref<MessageScrollerHandle | null>(null);
    const messageVirtualizer = ref<VirtualizerHandle | null>(null);
    const scrollViewport = ref<HTMLElement | null>(null);
    const viewportHeight = ref(0);
    provide(MARKDOWN_SCROLL_ROOT_KEY, () => scrollViewport.value);
    const virtualizeMessages = computed(() => displayMessages.value.length >= 12);
    const displayMessages = computed<SessionMessage[]>(() => {
        if (!props.pendingMessages?.length) {
            return props.messages;
        }

        return [
            ...props.messages,
            ...props.pendingMessages.map((message) => toPendingSessionMessage(message)),
        ];
    });
    const messagesWithoutVirtualization = computed(() =>
        virtualizeMessages.value ? [] : displayMessages.value
    );
    const navigationTarget = ref<NavigationTarget | null>(null);
    const navigationMountedIndexes = computed(() => {
        const index = displayMessages.value.findIndex(
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
    const RAIL_PREVIEW_SOURCE_LENGTH = 320;
    const compactionAnnouncement = ref<ContextCompactionMessagePart['state']>();

    // Keep announcements outside the busy virtual list and ignore restored checkpoints.
    onMounted(() => {
        let announcedCompaction: { messageId: string; id: string } | undefined;
        watch(
            () => {
                const message = displayMessages.value[displayMessages.value.length - 1];
                let compaction: ContextCompactionMessagePart | undefined;
                if (message) {
                    for (let index = message.parts.length - 1; index >= 0; index--) {
                        const part = message.parts[index];
                        if (part?.type === 'context_compaction') {
                            compaction = part;
                            break;
                        }
                    }
                }
                return [
                    message?.id,
                    message?.isStreaming,
                    compaction?.id,
                    compaction?.state,
                ] as const;
            },
            ([messageId, streaming, id, state]) => {
                if (messageId && streaming && id && state === 'compacting') {
                    announcedCompaction = { messageId, id };
                    compactionAnnouncement.value = state;
                } else if (
                    state === 'compacted' &&
                    id === announcedCompaction?.id &&
                    messageId === announcedCompaction?.messageId
                ) {
                    compactionAnnouncement.value = state;
                } else {
                    announcedCompaction = undefined;
                    compactionAnnouncement.value = undefined;
                }
            },
            { immediate: true }
        );
    });

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

        for (const message of displayMessages.value) {
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

    const turnIndexes = computed(() => {
        const turns = new Map<string, { first: number; last: number }>();
        let turn: { first: number; last: number } | undefined;
        displayMessages.value.forEach((message, index) => {
            if (message.role === 'user') {
                turn = { first: index, last: index };
                turns.set(message.id, turn);
            } else if (turn) {
                turn.last = index;
            }
        });
        return turns;
    });

    function railItemRange(itemId: string): { top: number; bottom: number } | null {
        const turn = turnIndexes.value.get(itemId);
        const virtualizer = messageVirtualizer.value;
        if (!turn || !virtualizer) return null;
        // Convert virtual list coordinates to the scrolling viewport's coordinates.
        const base = (scrollViewport.value?.scrollTop ?? 0) - virtualizer.scrollOffset;
        return {
            top: base + virtualizer.getItemOffset(turn.first),
            bottom:
                base + virtualizer.getItemOffset(turn.last) + virtualizer.getItemSize(turn.last),
        };
    }

    function focus() {
        conversationScroller.value?.focus();
    }

    function revealLatestContent() {
        cancelNavigation();
        conversationScroller.value?.scrollToEnd('auto');
        showScrollToBottom.value = false;
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

    function getContentHeight() {
        return conversationScroller.value?.getContentHeight() ?? 0;
    }

    defineExpose({
        focus,
        revealLatestContent,
        scrollByDelta,
        getHistoryAnchor,
        isLatestContentVisible,
        getContentHeight,
    });

    function handleRegenerateMessage(messageId: string) {
        emit('regenerateMessage', messageId);
    }

    function handleScrollerStateChange(state: MessageScrollerState) {
        viewportHeight.value = state.clientHeight;
        showScrollToBottom.value = state.overflowing && !state.atEnd;
        emit('latestContentVisibilityChange', state.atEnd);
    }

    function handleFollowChange(following: boolean) {
        if (following) cancelNavigation();
    }

    function scrollToMessageById(
        messageId: string,
        options: MessageScrollerScrollOptions = {}
    ): boolean {
        if (
            !messageVirtualizer.value ||
            !displayMessages.value.some(({ id }) => id === messageId)
        ) {
            return false;
        }
        conversationScroller.value?.setFollowing(false);
        // Mount the target first. scrollToIndex's own resize correction would race
        // the virtualizer's relative compensation when neighbouring rows are measured.
        navigationTarget.value = {
            id: messageId,
            align: options.align ?? 'center',
            gap: options.offset ?? 0,
        };
        scheduleNavigationMeasure();
        return true;
    }

    function scheduleNavigationMeasure(): void {
        if (!navigationTarget.value || navigationMeasurePending) return;
        navigationMeasurePending = true;
        // Align after virtua commits measured offsets and scroll compensation.
        void nextTick(() => {
            navigationMeasurePending = false;
            const target = navigationTarget.value;
            const viewport = scrollViewport.value;
            if (!target || !viewport) return;
            const element = viewport.querySelector<HTMLElement>(
                `[data-message-id="${CSS.escape(target.id)}"]`
            );
            if (!element) return;
            const rect = element.getBoundingClientRect();
            const desiredOffset = resolveDesiredOffset(
                target.align,
                target.gap,
                rect.height,
                viewport.clientHeight
            );
            const correction = resolveNavigationCorrection(
                rect.top - viewport.getBoundingClientRect().top,
                desiredOffset
            );
            const top = Math.min(
                Math.max(0, viewport.scrollHeight - viewport.clientHeight),
                Math.max(0, viewport.scrollTop + correction)
            );
            if (Math.abs(top - viewport.scrollTop) > 1) viewport.scrollTop = top;
        });
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

    function refreshScrollToBottomVisibility() {
        const state = conversationScroller.value?.getState();
        showScrollToBottom.value = Boolean(state?.overflowing && !state.atEnd);
        emit('latestContentVisibilityChange', state?.atEnd ?? true);
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

    watch(() => displayMessages.value[0]?.id, cancelNavigation);

    watch(
        () => displayMessages.value.length,
        async (newLength, oldLength) => {
            if (newLength === 0 && oldLength > 0) {
                showScrollToBottom.value = false;
                await nextTick();
                refreshScrollToBottomVisibility();
                return;
            }

            if (newLength <= oldLength) return;

            const appendedMessages = displayMessages.value.slice(oldLength, newLength);
            const latestAppendedUserMessage = [...appendedMessages]
                .reverse()
                .find((message) => message.role === 'user');

            await nextTick();

            if (outputScrollBehavior.value === 'follow_output') {
                if (latestAppendedUserMessage) {
                    revealLatestContent();
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
                revealLatestContent();
                return;
            }
            refreshScrollToBottomVisibility();
        },
        { immediate: true }
    );

    onMounted(async () => {
        scrollViewport.value = conversationScroller.value?.getViewportElement() ?? null;
        await settingsStore.initialize();
        await nextTick();
        if (outputScrollBehavior.value === 'follow_output') {
            conversationScroller.value?.scrollToEnd('auto');
            return;
        }
        refreshScrollToBottomVisibility();
    });

    onBeforeUnmount(cancelNavigation);
</script>

<style scoped>
    .scroll-fade-overlay {
        background: linear-gradient(to bottom, transparent 0%, var(--color-overlay-fade) 100%);
    }
</style>
