<template>
    <div
        ref="panelElement"
        data-testid="result-panel"
        data-slot="result-panel"
        class="flex min-h-0 w-full flex-col justify-end overflow-hidden font-serif"
        :class="
            floating
                ? 'rounded-t-lg border-x border-t border-search-border bg-search-floating-surface py-2 backdrop-blur-search-floating'
                : 'mt-1.5 flex-1 p-1'
        "
        :style="{
            height:
                height === undefined
                    ? undefined
                    : floating
                      ? `${height}px`
                      : `calc(${height}px - var(--spacing) * 1.5)`,
            maxHeight:
                maxHeight === undefined
                    ? undefined
                    : floating
                      ? `${maxHeight}px`
                      : `calc(${maxHeight}px - var(--spacing) * 1.5)`,
        }"
        @mousedown="handleMouseDown"
        @click.self="emit('blankClick')"
    >
        <div
            :id="listId"
            :ref="assignViewport"
            data-slot="result-panel-viewport"
            :data-scroll-fade="floating ? '' : undefined"
            :role="listId ? 'listbox' : undefined"
            :aria-label="listLabel"
            :aria-busy="state?.kind === 'loading' || busy"
            class="flex min-h-0 w-full overflow-x-hidden overflow-y-auto"
            :class="[
                floating ? 'px-2' : 'rounded-lg bg-search-surface p-2',
                layout === 'grid' ? 'items-start' : 'flex-col',
                viewportHeight === undefined ? 'max-h-80 flex-1' : '',
            ]"
            :style="{
                ...(floating ? scrollFadeStyle : {}),
                height:
                    fittedViewportHeight === undefined ? undefined : `${fittedViewportHeight}px`,
                padding:
                    floating || viewportPadding === undefined ? undefined : `${viewportPadding}px`,
            }"
            @scroll.passive="emit('scroll', $event)"
            @wheel="emit('wheel', $event)"
            @click.self="emit('blankClick')"
        >
            <div
                v-if="state"
                :role="state.kind === 'error' ? 'alert' : 'status'"
                class="flex min-h-12 w-full shrink-0 items-center justify-center px-3 text-center text-sm"
                :class="state.kind === 'error' ? 'text-text-danger' : 'text-search-muted'"
            >
                {{ state.message }}
            </div>
            <slot v-else />
        </div>
        <div
            v-if="!floating && (shortcuts.length || statusGroups.length || busy || $slots.actions)"
            ref="footerElement"
            data-slot="result-panel-footer"
            class="flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2"
        >
            <ResultShortcut v-for="shortcut in shortcuts" :key="shortcut.label" v-bind="shortcut" />
            <slot name="actions" />
            <div v-if="statusGroups.length || busy" class="ml-auto flex min-w-0 items-center gap-2">
                <span
                    v-if="busy"
                    aria-hidden="true"
                    class="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border border-search-loading-border border-t-search-control"
                ></span>
                <div
                    v-if="statusGroups.length"
                    data-slot="result-panel-status"
                    class="flex min-w-0 items-center gap-3 text-xs leading-5 text-search-muted select-none"
                >
                    <span
                        v-for="(group, index) in statusGroups"
                        :key="index"
                        class="truncate"
                        :title="group"
                    >
                        {{ group }}
                    </span>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
    import { useScrollFade } from '@composables/useScrollFade';
    import type { ComponentPublicInstance } from 'vue';
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import {
        RESULT_COMPACT_MAX_ROWS,
        RESULT_SCROLL_FADE_SIZE,
        RESULT_VIEWPORT_PADDING,
    } from './layout';
    import { revealResultRange } from './navigation';
    import ResultShortcut from './ResultShortcut.vue';
    import type { ResultPanelShortcut, ResultPanelState } from './types';

    defineOptions({ name: 'UiResultPanel' });

    const props = withDefaults(
        defineProps<{
            layout?: 'list' | 'grid';
            listId?: string;
            listLabel?: string;
            activeItemId?: string;
            state?: ResultPanelState | null;
            status?: string | readonly string[];
            shortcuts?: readonly ResultPanelShortcut[];
            busy?: boolean;
            preserveFocus?: boolean;
            floating?: boolean;
            height?: number;
            maxHeight?: number;
            viewportHeight?: number;
            viewportPadding?: number;
            rowHeight?: number;
        }>(),
        {
            layout: 'list',
            listId: undefined,
            listLabel: undefined,
            activeItemId: undefined,
            state: null,
            status: '',
            shortcuts: () => [],
            busy: false,
            preserveFocus: false,
            floating: false,
            height: undefined,
            maxHeight: undefined,
            viewportHeight: undefined,
            viewportPadding: undefined,
            rowHeight: undefined,
        }
    );

    const emit = defineEmits<{
        blankClick: [];
        scroll: [event: Event];
        wheel: [event: WheelEvent];
        viewportChange: [element: HTMLElement | null];
        contentResize: [];
    }>();
    const panelElement = ref<HTMLElement | null>(null);
    const footerElement = ref<HTMLElement | null>(null);
    const viewport = ref<HTMLElement | null>(null);
    const { scrollFadeStyle } = useScrollFade(
        computed(() => (props.floating ? viewport.value : null)),
        RESULT_SCROLL_FADE_SIZE
    );
    const fittedViewportHeight = computed(() => {
        if (!props.floating || !props.rowHeight || props.viewportHeight === undefined)
            return props.viewportHeight;
        // Keep vertical insets outside the scroller so the next row cannot peek into them.
        const available = Math.min(
            props.viewportHeight - RESULT_VIEWPORT_PADDING * 2,
            props.rowHeight * RESULT_COMPACT_MAX_ROWS,
            (props.maxHeight ?? Infinity) - RESULT_VIEWPORT_PADDING * 2 - 1
        );
        return Math.max(0, Math.floor(available / props.rowHeight) * props.rowHeight);
    });
    const statusGroups = computed(() =>
        typeof props.status === 'string' ? (props.status ? [props.status] : []) : props.status
    );

    function assignViewport(element: Element | ComponentPublicInstance | null) {
        viewport.value = element instanceof HTMLElement ? element : null;
        emit('viewportChange', viewport.value);
    }

    function handleMouseDown(event: MouseEvent) {
        if (!props.preserveFocus) return;
        event.preventDefault();
        event.stopPropagation();
    }

    function getContentHeight(): number {
        const panel = panelElement.value;
        if (!panel) return 0;
        const style = getComputedStyle(panel);
        const chrome = [
            style.paddingTop,
            style.paddingBottom,
            style.borderTopWidth,
            style.borderBottomWidth,
            style.marginTop,
            style.marginBottom,
        ].reduce((total, value) => total + (Number.parseFloat(value) || 0), 0);
        return Math.min(
            props.maxHeight ?? Infinity,
            (fittedViewportHeight.value ?? viewport.value?.scrollHeight ?? 0) +
                (footerElement.value?.getBoundingClientRect().height ?? 0) +
                chrome
        );
    }

    watch(
        [
            () => props.viewportHeight,
            () => props.state,
            () => props.floating,
            () => props.shortcuts,
            statusGroups,
        ],
        () => emit('contentResize'),
        { flush: 'post' }
    );
    onMounted(() => emit('contentResize'));
    defineExpose({ getContentHeight });

    function revealActiveItem(container = viewport.value, id = props.activeItemId) {
        const element = id ? container?.ownerDocument.getElementById(id) : null;
        if (!element || !container?.contains(element)) return;
        const row = element.getBoundingClientRect();
        const top = row.top - container.getBoundingClientRect().top + container.scrollTop;
        const padding = Number.parseFloat(getComputedStyle(container).paddingTop) || 0;
        revealResultRange(container, top, top + row.height, padding);
    }

    watch(
        () => props.activeItemId,
        () => revealActiveItem(),
        { flush: 'post' }
    );
    const viewportResizeObserver =
        typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => revealActiveItem());
    watch(
        viewport,
        (container) => {
            viewportResizeObserver?.disconnect();
            if (!container) return;
            viewportResizeObserver?.observe(container);
            revealActiveItem(container);
        },
        { flush: 'post', immediate: true }
    );
    onBeforeUnmount(() => viewportResizeObserver?.disconnect());
</script>

<style scoped>
    [data-slot='result-panel-viewport'] {
        scrollbar-width: none;
    }

    [data-slot='result-panel-viewport']::-webkit-scrollbar {
        display: none;
    }
</style>
