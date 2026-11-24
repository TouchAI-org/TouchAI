<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { ref } from 'vue';

    import { t } from '@/i18n';

    defineOptions({
        name: 'SearchConversationToolbar',
    });

    interface Props {
        isPinned: boolean;
        isMaximized?: boolean;
        historyOpen: boolean;
        canPin?: boolean;
        disabled?: boolean;
        startDragging: (event: MouseEvent) => Promise<void>;
    }

    const props = withDefaults(defineProps<Props>(), {
        canPin: true,
        disabled: false,
    });

    const emit = defineEmits<{
        pinChange: [isPinned: boolean];
        maximizeToggle: [];
        newSession: [];
        historyOpenChange: [payload: { open: boolean; anchorElement: HTMLElement | null }];
        historyPrefetch: [anchorElement: HTMLElement | null];
        wheel: [deltaY: number];
        dragStart: [];
        dragEnd: [];
    }>();

    const historyAnchorRef = ref<HTMLElement | null>(null);

    function togglePinned() {
        emit('pinChange', !props.isPinned);
    }

    function toggleMaximized() {
        if (props.disabled) {
            return;
        }

        emit('maximizeToggle');
    }

    function handleNewSession() {
        if (props.disabled) {
            return;
        }

        emit('newSession');
    }

    function toggleHistory() {
        if (props.disabled) {
            return;
        }

        emit('historyOpenChange', {
            open: !props.historyOpen,
            anchorElement: historyAnchorRef.value,
        });
    }

    function handleHistoryPrefetch() {
        if (props.disabled) {
            return;
        }

        emit('historyPrefetch', historyAnchorRef.value);
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
            await props.startDragging(event);
        } finally {
            emit('dragEnd');
        }
    }

    function getHistoryAnchor() {
        return historyAnchorRef.value;
    }

    defineExpose({
        getHistoryAnchor,
    });
</script>

<template>
    <div
        data-slot="conversation-toolbar"
        class="toolbar-fade-overlay pointer-events-auto absolute top-0 right-0 left-0 z-100 flex h-18 cursor-grab items-start px-10 pt-3 active:cursor-grabbing"
        @mousedown="handleToolbarDragMouseDown"
        @wheel.passive="emit('wheel', $event.deltaY)"
    >
        <div class="flex items-center gap-2.5">
            <button
                type="button"
                class="toolbar-button"
                :class="disabled ? 'toolbar-button--disabled' : ''"
                :aria-label="t('conversation.toolbar.newSession')"
                data-drag-exclude="true"
                @mousedown.stop
                @click.stop="handleNewSession"
            >
                <AppIcon name="new-session" class="h-4 w-4" />
            </button>

            <div
                ref="historyAnchorRef"
                class="relative flex"
                data-drag-exclude="true"
                data-history-trigger="true"
            >
                <button
                    type="button"
                    class="toolbar-button"
                    :class="[
                        disabled ? 'toolbar-button--disabled' : '',
                        historyOpen ? 'toolbar-button--active' : '',
                    ]"
                    :aria-label="t('conversation.toolbar.openHistory')"
                    data-drag-exclude="true"
                    data-history-trigger="true"
                    @mousedown.stop
                    @mouseenter="handleHistoryPrefetch"
                    @click.stop="toggleHistory"
                >
                    <AppIcon name="session-history" class="h-4 w-4" />
                </button>
            </div>
        </div>

        <div class="ml-auto flex items-center gap-2.5">
            <button
                v-if="canPin"
                type="button"
                class="toolbar-button"
                :class="isPinned ? 'toolbar-button--pinned' : ''"
                :aria-label="t('conversation.toolbar.pinWindow')"
                :aria-pressed="isPinned"
                data-drag-exclude="true"
                @mousedown.stop
                @click.stop="togglePinned"
            >
                <AppIcon name="pin" class="h-4 w-4" />
            </button>

            <button
                type="button"
                class="toolbar-button"
                :class="disabled ? 'toolbar-button--disabled' : ''"
                :aria-label="
                    isMaximized
                        ? t('conversation.toolbar.restoreWindow')
                        : t('conversation.toolbar.maximizeWindow')
                "
                :aria-pressed="isMaximized"
                data-drag-exclude="true"
                @mousedown.stop
                @click.stop="toggleMaximized"
            >
                <AppIcon
                    :name="isMaximized ? 'restore-square' : 'maximize-square'"
                    class="h-4 w-4"
                    :class="isMaximized ? '-scale-x-100' : ''"
                />
            </button>
        </div>
    </div>
</template>

<style scoped>
    .toolbar-fade-overlay {
        background: linear-gradient(to bottom, var(--color-overlay-fade) 0%, transparent 100%);
    }

    .toolbar-button {
        display: inline-flex;
        height: 2.25rem;
        width: 2.25rem;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-lg);
        color: var(--color-conversation-toolbar);
        transition:
            color var(--duration-quick) var(--ease-smooth-out),
            background-color var(--duration-quick) var(--ease-smooth-out);
    }

    .toolbar-button:hover,
    .toolbar-button:focus-visible,
    .toolbar-button--active {
        background: var(--color-surface-hover);
        color: var(--color-conversation-toolbar-hover-text);
    }

    .toolbar-button--pinned {
        color: var(--color-conversation-toolbar-pinned-text);
    }

    .toolbar-button--pinned:hover,
    .toolbar-button--pinned:focus-visible {
        background: var(--color-surface-hover);
        color: var(--color-conversation-toolbar-pinned-text);
    }

    .toolbar-button--disabled {
        cursor: not-allowed;
        opacity: 0.45;
        pointer-events: none;
    }
</style>
