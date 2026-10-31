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
            @state-change="handleScrollerStateChange"
        >
            <div
                v-for="message in messages"
                :key="message.id"
                :data-message-id="message.id"
                :data-message-role="message.role"
                :data-message-scroller-item="message.id"
            >
                <MessageItem :message="message" @regenerate="handleRegenerateMessage" />
            </div>
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
    import { computed, nextTick, onMounted, ref, watch } from 'vue';

    import {
        MessageScroller,
        type MessageScrollerHandle,
        type MessageScrollerItem,
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

    function handleScrollerStateChange(state: MessageScrollerState) {
        showScrollToBottom.value = state.overflowing && !state.atEnd;
        emitLatestContentVisibility();
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
        if (outputScrollBehavior.value === 'follow_output') {
            conversationScroller.value?.scrollToEnd('auto');
            return;
        }
        refreshScrollToBottomVisibility();
    });
</script>

<style scoped>
    .scroll-fade-overlay {
        background: linear-gradient(to bottom, transparent 0%, var(--color-overlay-fade) 100%);
    }
</style>
