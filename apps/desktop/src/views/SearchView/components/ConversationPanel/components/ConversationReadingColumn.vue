<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';

    import { CONVERSATION_WIDTH, normalizeConversationWidth } from '@/config/conversationWidth';
    import { t } from '@/i18n';

    const props = withDefaults(defineProps<{ width?: number; controls: string }>(), {
        width: CONVERSATION_WIDTH.default,
    });
    const emit = defineEmits<{ commit: [width: number]; scrollBy: [delta: number] }>();
    const edges = ['left', 'right'] as const;
    type Edge = (typeof edges)[number];

    const frame = ref<HTMLElement | null>(null);
    const available = ref(0);
    const editable = computed(() => available.value >= CONVERSATION_WIDTH.default);
    const maximum = computed(() => Math.min(CONVERSATION_WIDTH.max, available.value));
    const draft = ref<number | null>(null);
    const preferred = computed(() => draft.value ?? props.width);
    const visibleWidth = computed(() => Math.min(preferred.value, maximum.value));
    const drag = shallowRef<{
        target: HTMLElement;
        pointer: number;
        startX: number;
        startWidth: number;
        edge: Edge;
    } | null>(null);
    const indicatorY = ref<number | null>(null);
    let observer: ResizeObserver | undefined;

    onMounted(() => {
        if (!frame.value || typeof ResizeObserver === 'undefined') return;
        observer = new ResizeObserver(([entry]) => {
            if (entry) available.value = entry.contentRect.width;
        });
        observer.observe(frame.value);
    });

    function commit(width: number) {
        if (width !== props.width) emit('commit', width);
    }

    function withinFrame(width: number) {
        const lastStep =
            Math.floor(maximum.value / CONVERSATION_WIDTH.step) * CONVERSATION_WIDTH.step;
        return Math.min(lastStep, normalizeConversationWidth(width));
    }

    function trackPointer(event: PointerEvent) {
        indicatorY.value = event.offsetY;
    }

    function beginDrag(event: PointerEvent, edge: Edge) {
        if (event.button !== 0 || drag.value) return;
        const target = event.currentTarget as HTMLElement;
        event.preventDefault();
        target.focus({ preventScroll: true });
        target.setPointerCapture(event.pointerId);
        drag.value = {
            target,
            pointer: event.pointerId,
            startX: event.clientX,
            startWidth: visibleWidth.value,
            edge,
        };
        trackPointer(event);
    }

    function preview(event: PointerEvent) {
        const active = drag.value;
        if (active && active.pointer !== event.pointerId) return;
        trackPointer(event);
        if (!active) return;
        const delta = (event.clientX - active.startX) * (active.edge === 'left' ? -2 : 2);
        draft.value =
            delta === 0 || (delta > 0 && active.startWidth >= maximum.value)
                ? null
                : withinFrame(active.startWidth + delta);
    }

    function cancelDrag() {
        const active = drag.value;
        drag.value = null;
        draft.value = null;
        if (active?.target.hasPointerCapture(active.pointer)) {
            active.target.releasePointerCapture(active.pointer);
        }
    }

    function finish(event: PointerEvent) {
        const active = drag.value;
        if (!active || active.pointer !== event.pointerId) return;
        preview(event);
        const width = draft.value;
        cancelDrag();
        if (width !== null && width !== active.startWidth) commit(width);
    }

    function onKey(event: KeyboardEvent, edge: Edge) {
        if (drag.value && event.key !== 'Escape') return;
        const step = edge === 'left' ? -CONVERSATION_WIDTH.step : CONVERSATION_WIDTH.step;
        switch (event.key) {
            case 'ArrowLeft':
            case 'ArrowRight': {
                const delta = event.key === 'ArrowLeft' ? -step : step;
                if (delta < 0 || visibleWidth.value < maximum.value) {
                    commit(withinFrame(visibleWidth.value + delta));
                }
                break;
            }
            case 'Home':
                commit(CONVERSATION_WIDTH.min);
                break;
            case 'End':
                commit(withinFrame(maximum.value));
                break;
            case 'Escape':
                if (!drag.value) return;
                cancelDrag();
                break;
            default:
                return;
        }
        event.preventDefault();
        event.stopPropagation();
    }

    watch(available, cancelDrag);
    onBeforeUnmount(() => {
        observer?.disconnect();
        cancelDrag();
    });
</script>

<template>
    <div
        data-slot="reading-frame"
        class="relative h-full min-h-0 w-full"
        :style="{
            '--column-width': `${preferred}px`,
            '--default-column-width': `${CONVERSATION_WIDTH.default}px`,
        }"
    >
        <slot />
        <div
            ref="frame"
            data-slot="reading-edges"
            class="pointer-events-none absolute inset-x-22 top-22 bottom-5"
        >
            <div
                v-if="editable"
                class="relative mx-auto h-full w-full max-w-(--column-width)"
                :style="{ '--indicator-y': indicatorY === null ? '50%' : `${indicatorY}px` }"
            >
                <div
                    v-for="edge in edges"
                    :key="edge"
                    class="group pointer-events-auto absolute inset-y-0 w-2.5 cursor-col-resize touch-none outline-none select-none"
                    :class="edge === 'left' ? 'right-full mr-6' : 'left-full ml-6'"
                    role="separator"
                    tabindex="0"
                    aria-orientation="vertical"
                    :aria-label="
                        t(
                            edge === 'left'
                                ? 'conversation.width.leftEdge'
                                : 'conversation.width.rightEdge'
                        )
                    "
                    :aria-controls="controls"
                    :aria-valuemin="CONVERSATION_WIDTH.min"
                    :aria-valuemax="maximum"
                    :aria-valuenow="visibleWidth"
                    :aria-valuetext="t('conversation.width.pixels', { width: visibleWidth })"
                    :title="t('conversation.width.handleHint')"
                    @pointerdown="beginDrag($event, edge)"
                    @pointermove="preview"
                    @pointerup="finish"
                    @pointercancel="drag?.pointer === $event.pointerId && cancelDrag()"
                    @lostpointercapture="drag?.pointer === $event.pointerId && cancelDrag()"
                    @blur="cancelDrag"
                    @keydown="onKey($event, edge)"
                    @wheel.passive="emit('scrollBy', $event.deltaY)"
                    @dblclick="commit(CONVERSATION_WIDTH.default)"
                >
                    <span
                        aria-hidden="true"
                        data-slot="reading-indicator"
                        class="pointer-events-none absolute left-1/2 h-16 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border-strong group-hover:opacity-100 group-focus-visible:bg-focus group-focus-visible:opacity-100"
                        :class="drag?.edge === edge ? 'opacity-100' : 'opacity-0'"
                    >
                        <span
                            v-if="drag?.edge === edge"
                            class="absolute top-1/2 -translate-y-1/2 rounded-control bg-surface-floating px-2 py-1 text-caption whitespace-nowrap text-text-secondary tabular-nums shadow-sm"
                            :class="edge === 'left' ? 'left-full ml-2' : 'right-full mr-2'"
                        >
                            {{ t('conversation.width.pixels', { width: visibleWidth }) }}
                        </span>
                    </span>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
    [data-slot='reading-frame'] :deep(.reading-viewport) {
        --reading-gutter: min(
            calc((100% - min(var(--column-width), var(--default-column-width))) / 2),
            calc(var(--spacing) * 22)
        );
        padding-inline-start: max(calc(var(--spacing) * 10), var(--reading-gutter));
        padding-inline-end: max(calc(var(--spacing) * 12), var(--reading-gutter));
    }

    [data-slot='reading-indicator'] {
        top: clamp(min(50%, 2rem), var(--indicator-y), max(50%, 100% - 2rem));
        max-height: 100%;
    }
</style>
