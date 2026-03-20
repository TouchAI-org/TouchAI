<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import SvgIcon from '@components/SvgIcon.vue';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { ref } from 'vue';

    defineOptions({
        name: 'SearchConversationToolbar',
    });

    interface Props {
        isPinned: boolean;
        historyOpen: boolean;
        canPin?: boolean;
        disabled?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        canPin: true,
        disabled: false,
    });

    const emit = defineEmits<{
        pinChange: [isPinned: boolean];
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
            await getCurrentWindow().startDragging();
        } finally {
            setTimeout(() => {
                emit('dragEnd');
            }, 100);
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
        class="toolbar-fade-overlay absolute top-0 right-0 left-0 z-30 flex h-[4.5rem] cursor-grab items-start px-10 pt-3 active:cursor-grabbing"
        @mousedown="handleToolbarDragMouseDown"
        @wheel.passive="emit('wheel', $event.deltaY)"
    >
        <div class="ml-auto flex items-center gap-2">
            <button
                type="button"
                class="toolbar-button"
                :class="disabled ? 'toolbar-button--disabled' : ''"
                aria-label="新建会话"
                data-drag-exclude="true"
                @mousedown.stop
                @click.stop="handleNewSession"
            >
                <SvgIcon name="plus" class="h-4 w-4" />
            </button>

            <div
                ref="historyAnchorRef"
                class="relative"
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
                    aria-label="打开会话历史"
                    data-drag-exclude="true"
                    data-history-trigger="true"
                    @mousedown.stop
                    @mouseenter="handleHistoryPrefetch"
                    @click.stop="toggleHistory"
                >
                    <SvgIcon name="history" class="h-4 w-4" />
                </button>
            </div>

            <button
                v-if="canPin"
                type="button"
                class="toolbar-button"
                :class="isPinned ? 'toolbar-button--active' : ''"
                aria-label="固定会话面板"
                data-drag-exclude="true"
                @mousedown.stop
                @click.stop="togglePinned"
            >
                <SvgIcon
                    name="pin"
                    class="h-4 w-4 transition-transform duration-200 ease-in-out"
                    :class="isPinned ? 'rotate-[-30deg]' : 'rotate-0'"
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
        height: 1.9rem;
        width: 1.9rem;
        align-items: center;
        justify-content: center;
        border-radius: 0.75rem;
        color: rgb(156, 163, 175);
        transition:
            color 0.2s ease,
            background-color 0.2s ease,
            box-shadow 0.2s ease;
    }

    .toolbar-button:hover,
    .toolbar-button--active {
        background: rgba(255, 255, 255, 0.92);
        color: rgb(82, 82, 91);
        box-shadow: 0 6px 18px rgba(15, 23, 42, 0.08);
    }

    .toolbar-button--disabled {
        cursor: not-allowed;
        opacity: 0.45;
        pointer-events: none;
    }
</style>
