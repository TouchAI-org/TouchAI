<script setup lang="ts">
    import { useMotion } from '@composables/useMotion';
    import { AnimatePresence, motion } from 'motion-v';
    import {
        computed,
        nextTick,
        onBeforeUnmount,
        onMounted,
        ref,
        type StyleValue,
        watch,
    } from 'vue';

    import { cn } from '@/lib/utils';

    import type {
        MessageScrollerItem,
        MessageScrollerScrollBehavior,
        MessageScrollerScrollOptions,
        MessageScrollerState,
    } from './types';

    defineOptions({
        name: 'UiMessageScroller',
    });

    const PREVIEW_TITLE_LENGTH = 56;
    const PREVIEW_DESCRIPTION_LENGTH = 88;
    const END_TOLERANCE = 5;
    const PROGRAMMATIC_SCROLL_SETTLE_MS = 320;
    const RAIL_ITEM_SIZE = 14;
    const RAIL_VERTICAL_PADDING = 8;
    const PREVIEW_MAX_HEIGHT = 112;
    const PREVIEW_HALF_HEIGHT = PREVIEW_MAX_HEIGHT / 2;
    const MAX_RAIL_ITEMS = 96;
    const RAIL_WAVE_SCALES = [1.5, 1.28, 1.12, 1.02] as const;
    const RAIL_WAVE_STEP_DELAY = 0.012;

    interface RailItem extends MessageScrollerItem {
        source: MessageScrollerItem;
    }

    interface Props {
        items?: MessageScrollerItem[];
        followOutput?: boolean;
        followThreshold?: number;
        smooth?: boolean;
        label: string;
        navigationLabel: string;
        emptyLabel: string;
        busy?: boolean;
        navigation?: 'rail';
        viewportClass?: string;
        contentClass?: string;
        viewportStyle?: StyleValue;
    }

    const props = withDefaults(defineProps<Props>(), {
        items: () => [],
        followOutput: true,
        followThreshold: 56,
        smooth: true,
        busy: false,
        navigation: undefined,
        viewportClass: '',
        contentClass: '',
        viewportStyle: undefined,
    });

    const emit = defineEmits<{
        followChange: [following: boolean];
        itemSelect: [item: MessageScrollerItem];
        stateChange: [state: MessageScrollerState];
    }>();

    const viewport = ref<HTMLElement | null>(null);
    const content = ref<HTMLElement | null>(null);
    const rail = ref<HTMLElement | null>(null);
    const railHeight = ref(0);
    const overflowing = ref(false);
    const atEnd = ref(true);
    const following = ref(props.followOutput);
    const activeItemId = ref(props.items[0]?.id ?? '');
    const visibleItemIds = ref<Set<string>>(new Set());
    const hoveredItemId = ref<string | null>(null);
    const pinnedItemId = ref<string | null>(null);
    const focusedItemId = ref<string | null>(null);

    const { reducedMotion, transitions } = useMotion();

    function normaliseText(text: string): string {
        return text.replace(/\s+/g, ' ').trim();
    }

    function splitText(text: string, limit: number) {
        const normalised = normaliseText(text);
        if (normalised.length <= limit) {
            return { label: normalised, remainder: '' };
        }

        const excerpt = normalised.slice(0, limit);
        const boundary = excerpt.lastIndexOf(' ');
        const end = boundary > limit * 0.65 ? boundary : limit;
        return {
            label: `${normalised.slice(0, end).trim()}...`,
            remainder: normalised.slice(end).trim(),
        };
    }

    function truncateText(text: string, limit: number): string {
        return splitText(text, limit).label;
    }

    function createRailItem(sourceIndex: number): RailItem {
        const source = props.items[sourceIndex]!;
        const preview = splitText(source.label || props.emptyLabel, PREVIEW_TITLE_LENGTH);
        const description = source.description
            ? truncateText(source.description, PREVIEW_DESCRIPTION_LENGTH)
            : preview.remainder
              ? truncateText(preview.remainder, PREVIEW_DESCRIPTION_LENGTH)
              : undefined;

        return {
            ...source,
            label: preview.label,
            description,
            source,
        };
    }

    const railItems = computed<RailItem[]>(() => {
        const count = props.items.length;
        if (count === 0) return [];
        if (count <= MAX_RAIL_ITEMS) {
            return props.items.map((_, index) => createRailItem(index));
        }

        return Array.from({ length: MAX_RAIL_ITEMS }, (_, index) =>
            createRailItem(Math.round((index * (count - 1)) / (MAX_RAIL_ITEMS - 1)))
        );
    });

    const displayedItemId = computed(
        () => hoveredItemId.value ?? pinnedItemId.value ?? focusedItemId.value
    );

    const displayedRailItem = computed(
        () => railItems.value.find((item) => item.id === displayedItemId.value) ?? null
    );

    const displayedRailItemIndex = computed(() =>
        railItems.value.findIndex((item) => item.id === displayedItemId.value)
    );

    const railVisible = computed(
        () => props.navigation === 'rail' && overflowing.value && railItems.value.length > 1
    );

    const railItemSize = computed(() => {
        const count = railItems.value.length;
        const availableHeight = Math.max(0, railHeight.value - RAIL_VERTICAL_PADDING);
        if (count === 0 || availableHeight === 0) return RAIL_ITEM_SIZE;
        return Math.min(RAIL_ITEM_SIZE, availableHeight / count);
    });

    const railStyle = computed(() => ({
        gridTemplateRows: `repeat(${railItems.value.length}, ${railItemSize.value}px)`,
    }));

    const previewStyle = computed(() => {
        if (displayedRailItemIndex.value < 0) return {};
        const centerOffset =
            (displayedRailItemIndex.value - (railItems.value.length - 1) / 2) * railItemSize.value;
        const previewCenter = railHeight.value / 2 + centerOffset;
        const minimumCenter = Math.min(PREVIEW_HALF_HEIGHT, railHeight.value / 2);
        const maximumCenter = Math.max(minimumCenter, railHeight.value - PREVIEW_HALF_HEIGHT);
        const top = railHeight.value
            ? `${Math.min(Math.max(previewCenter, minimumCenter), maximumCenter)}px`
            : `calc(50% + ${centerOffset}px)`;
        return {
            top,
            right: 'calc(100% + 0.5rem)',
            transform: 'translateY(-50%)',
        };
    });

    function railTickDistance(index: number): number {
        if (displayedRailItemIndex.value < 0) return Number.POSITIVE_INFINITY;
        return Math.abs(index - displayedRailItemIndex.value);
    }

    function railTickScale(index: number): number {
        return RAIL_WAVE_SCALES[railTickDistance(index)] ?? 1;
    }

    function railTickStyle(index: number) {
        const distance = railTickDistance(index);
        const delay =
            reducedMotion.value || !Number.isFinite(distance) ? 0 : distance * RAIL_WAVE_STEP_DELAY;
        return {
            transform: `scaleX(${railTickScale(index)})`,
            transition: reducedMotion.value
                ? 'none'
                : `transform var(--duration-quick) var(--ease-smooth-out) ${delay}s`,
        };
    }

    const viewportClasses = computed(() =>
        cn(
            'h-full overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring no-scrollbar',
            props.viewportClass,
            railVisible.value ? 'pr-12' : ''
        )
    );

    const contentClasses = computed(() => cn('min-h-full', props.contentClass));

    let resizeObserver: ResizeObserver | null = null;
    let programmaticScroll = false;
    let programmaticScrollTimer: ReturnType<typeof setTimeout> | null = null;
    let measureFrame: number | null = null;
    let followFrame: number | null = null;
    let measureUpdatesFollowing = false;
    let lastEmittedState = '';
    let touchStartScrollTop = 0;

    type FrameCallback = (timestamp: number) => void;

    function requestFrame(callback: FrameCallback): number {
        if (typeof requestAnimationFrame === 'function') {
            return requestAnimationFrame(callback);
        }
        return window.setTimeout(() => callback(Date.now()), 0);
    }

    function cancelFrame(frame: number): void {
        if (typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(frame);
            return;
        }
        window.clearTimeout(frame);
    }

    function readState(updateFollowing = false): MessageScrollerState {
        const element = viewport.value;
        if (!element) {
            return {
                atEnd: true,
                overflowing: false,
                following: following.value,
                scrollTop: 0,
                scrollHeight: 0,
                clientHeight: 0,
            };
        }

        const distance = Math.max(
            0,
            element.scrollHeight - element.scrollTop - element.clientHeight
        );
        const nextFollowing = distance <= props.followThreshold;

        if (updateFollowing) {
            setFollowing(nextFollowing);
        }

        const nextState: MessageScrollerState = {
            atEnd: distance <= END_TOLERANCE,
            overflowing: element.scrollHeight > element.clientHeight + 1,
            following: following.value,
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
        };

        atEnd.value = nextState.atEnd;
        overflowing.value = nextState.overflowing;
        return nextState;
    }

    function setFollowing(next: boolean): void {
        if (following.value === next) return;
        following.value = next;
        emit('followChange', next);
    }

    function emitState(state: MessageScrollerState): void {
        const key = [
            state.atEnd,
            state.overflowing,
            state.following,
            state.scrollTop,
            state.scrollHeight,
            state.clientHeight,
        ].join(':');
        if (key === lastEmittedState) return;
        lastEmittedState = key;
        emit('stateChange', state);
    }

    function escapedId(id: string): string {
        return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id;
    }

    function findItemElement(id: string): HTMLElement | null {
        return (
            content.value?.querySelector<HTMLElement>(
                `[data-message-scroller-item="${escapedId(id)}"]`
            ) ?? null
        );
    }

    function sameIds(left: Set<string>, right: Set<string>): boolean {
        if (left.size !== right.size) return false;
        return [...left].every((id) => right.has(id));
    }

    function updateVisibleItems(element: HTMLElement, viewportRect: DOMRect): void {
        const viewportBottom =
            viewportRect.height > 0 ? viewportRect.bottom : viewportRect.top + element.clientHeight;
        const nextIds = new Set<string>();

        for (const item of railItems.value) {
            const target = findItemElement(item.id);
            if (!target) continue;

            const rect = target.getBoundingClientRect();
            if (rect.bottom > viewportRect.top && rect.top < viewportBottom) {
                nextIds.add(item.id);
            }
        }

        if (!sameIds(visibleItemIds.value, nextIds)) {
            visibleItemIds.value = nextIds;
        }
    }

    function updateActiveItem(): void {
        const element = viewport.value;
        if (!element || !railVisible.value) {
            activeItemId.value = railItems.value[0]?.id ?? '';
            visibleItemIds.value = new Set();
            return;
        }

        const viewportRect = element.getBoundingClientRect();
        updateVisibleItems(element, viewportRect);

        if (element.scrollTop <= props.followThreshold) {
            activeItemId.value = railItems.value[0]?.id ?? '';
            return;
        }

        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        if (distance <= props.followThreshold) {
            activeItemId.value = railItems.value[railItems.value.length - 1]?.id ?? '';
            return;
        }

        const viewportCenter = viewportRect.top + viewportRect.height / 2;
        let nearestId = railItems.value[0]?.id ?? '';
        let nearestDistance = Number.POSITIVE_INFINITY;

        for (const item of railItems.value) {
            const target = findItemElement(item.id);
            if (!target) continue;
            const rect = target.getBoundingClientRect();
            const center = rect.top + rect.height / 2;
            const itemDistance = Math.abs(center - viewportCenter);
            if (itemDistance < nearestDistance) {
                nearestDistance = itemDistance;
                nearestId = item.id;
            }
        }

        activeItemId.value = nearestId;
    }

    function measure(updateFollowing = false): void {
        const state = readState(updateFollowing);
        updateActiveItem();
        railHeight.value = rail.value?.clientHeight ?? 0;
        emitState(state);
    }

    function scheduleMeasure(updateFollowing = false): void {
        measureUpdatesFollowing ||= updateFollowing;
        if (measureFrame !== null) return;
        measureFrame = requestFrame(() => {
            measureFrame = null;
            const shouldUpdateFollowing = measureUpdatesFollowing;
            measureUpdatesFollowing = false;
            measure(shouldUpdateFollowing);
        });
    }

    function defaultFollowBehavior(): MessageScrollerScrollBehavior {
        return reducedMotion.value || !props.smooth ? 'auto' : 'smooth';
    }

    function scrollViewportTo(top: number, behavior: MessageScrollerScrollBehavior): void {
        const element = viewport.value;
        if (!element) return;

        const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
        const boundedTop = Math.min(Math.max(0, top), maxTop);
        const effectiveBehavior = reducedMotion.value ? 'auto' : behavior;

        programmaticScroll = true;
        if (programmaticScrollTimer) clearTimeout(programmaticScrollTimer);

        try {
            if (typeof element.scrollTo === 'function') {
                element.scrollTo({ top: boundedTop, behavior: effectiveBehavior });
            } else {
                element.scrollTop = boundedTop;
            }
        } catch {
            element.scrollTop = boundedTop;
        }

        programmaticScrollTimer = setTimeout(
            () => {
                programmaticScroll = false;
                programmaticScrollTimer = null;
                scheduleMeasure(true);
            },
            effectiveBehavior === 'smooth' ? PROGRAMMATIC_SCROLL_SETTLE_MS : 0
        );
    }

    function scrollToEnd(behavior: MessageScrollerScrollBehavior = defaultFollowBehavior()): void {
        const element = viewport.value;
        if (!element) return;

        setFollowing(true);
        scrollViewportTo(element.scrollHeight, behavior);
    }

    function scrollToItem(id: string, options: MessageScrollerScrollOptions = {}): boolean {
        const element = viewport.value;
        const target = findItemElement(id);
        if (!element || !target) return false;

        const align = options.align ?? 'center';
        const offset = options.offset ?? 0;
        const behavior = options.behavior ?? defaultFollowBehavior();
        const viewportRect = element.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        let top = element.scrollTop + targetRect.top - viewportRect.top - offset;

        if (align === 'center') {
            top -= (element.clientHeight - targetRect.height) / 2;
        } else if (align === 'end') {
            top -= element.clientHeight - targetRect.height;
        }

        setFollowing(align === 'end');
        scrollViewportTo(top, behavior);
        return true;
    }

    function scrollBy(deltaY: number): void {
        const element = viewport.value;
        if (!element || deltaY === 0) return;
        interruptProgrammaticScroll();
        if (deltaY < 0) setFollowing(false);
        element.scrollTop += deltaY;
        scheduleMeasure(true);
    }

    function isAtEnd(): boolean {
        return readState().atEnd;
    }

    function getState(): MessageScrollerState {
        return readState();
    }

    function focus(): void {
        viewport.value?.focus({ preventScroll: true });
    }

    function interruptProgrammaticScroll(): void {
        programmaticScroll = false;
        if (programmaticScrollTimer) {
            clearTimeout(programmaticScrollTimer);
            programmaticScrollTimer = null;
        }
    }

    function handleScroll(): void {
        scheduleMeasure(!programmaticScroll);
    }

    function handleWheel(event: WheelEvent): void {
        interruptProgrammaticScroll();
        if (event.deltaY < 0) setFollowing(false);
    }

    function handleTouchStart(): void {
        interruptProgrammaticScroll();
        touchStartScrollTop = viewport.value?.scrollTop ?? 0;
    }

    function handleTouchMove(): void {
        const element = viewport.value;
        if (element && element.scrollTop < touchStartScrollTop) {
            setFollowing(false);
        }
    }

    function handleViewportKeyboard(event: KeyboardEvent): void {
        const scrollKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
        if (scrollKeys.includes(event.key)) {
            interruptProgrammaticScroll();
        }
        if (
            event.key === 'ArrowUp' ||
            event.key === 'PageUp' ||
            event.key === 'Home' ||
            (event.key === ' ' && event.shiftKey)
        ) {
            setFollowing(false);
        }
    }

    function handleResize(): void {
        scheduleMeasure(false);
        if (!props.followOutput || !following.value) return;
        if (followFrame !== null) cancelFrame(followFrame);
        followFrame = requestFrame(() => {
            followFrame = null;
            if (!props.followOutput || !following.value) return;
            scrollToEnd(defaultFollowBehavior());
        });
    }

    function setupResizeObserver(): void {
        if (typeof ResizeObserver === 'undefined') return;
        resizeObserver = new ResizeObserver(handleResize);
        if (content.value) resizeObserver.observe(content.value);
        if (viewport.value) resizeObserver.observe(viewport.value);
    }

    function handlePointerEnter(event: PointerEvent, id: string): void {
        if (event.pointerType === 'mouse' && event.buttons === 0) {
            hoveredItemId.value = id;
        }
    }

    function handlePointerLeave(event: PointerEvent): void {
        if (event.pointerType !== 'touch') hoveredItemId.value = null;
    }

    function handlePointerDown(event: PointerEvent, id: string): void {
        focusedItemId.value = null;
        if (event.pointerType !== 'mouse') pinnedItemId.value = id;
    }

    function handleFocus(event: FocusEvent, id: string): void {
        if ((event.currentTarget as HTMLElement).matches(':focus-visible')) {
            focusedItemId.value = id;
        }
    }

    function handleBlur(event: FocusEvent): void {
        const next = event.relatedTarget as Node | null;
        if (!rail.value?.contains(next)) {
            focusedItemId.value = null;
            pinnedItemId.value = null;
        }
    }

    function handleRailItemSelect(item: RailItem): void {
        emit('itemSelect', item.source);
        scrollToItem(item.id, { align: 'center' });
    }

    function handleOutsidePointerDown(event: PointerEvent): void {
        if (!rail.value?.contains(event.target as Node)) {
            pinnedItemId.value = null;
        }
    }

    function handleGlobalEscape(event: KeyboardEvent): void {
        if (event.key === 'Escape') pinnedItemId.value = null;
    }

    function addPinnedDismissListeners(): void {
        window.addEventListener('pointerdown', handleOutsidePointerDown, true);
        window.addEventListener('keydown', handleGlobalEscape, true);
    }

    function removePinnedDismissListeners(): void {
        window.removeEventListener('pointerdown', handleOutsidePointerDown, true);
        window.removeEventListener('keydown', handleGlobalEscape, true);
    }

    watch(pinnedItemId, (id) => {
        removePinnedDismissListeners();
        if (id) addPinnedDismissListeners();
    });

    watch(
        () => props.items,
        () => {
            scheduleMeasure(false);
        }
    );

    watch(
        () => props.followOutput,
        async (enabled) => {
            if (!enabled) {
                setFollowing(false);
                return;
            }

            setFollowing(true);
            await nextTick();
            scrollToEnd('auto');
        }
    );

    watch(railVisible, (visible) => {
        if (visible) {
            scheduleMeasure(false);
            return;
        }
        railHeight.value = 0;
    });

    watch(rail, (element) => {
        railHeight.value = element?.clientHeight ?? 0;
    });

    onMounted(async () => {
        setupResizeObserver();
        await nextTick();
        if (props.followOutput) scrollToEnd('auto');
        measure(false);
    });

    onBeforeUnmount(() => {
        resizeObserver?.disconnect();
        resizeObserver = null;
        removePinnedDismissListeners();
        interruptProgrammaticScroll();
        if (measureFrame !== null) cancelFrame(measureFrame);
        if (followFrame !== null) cancelFrame(followFrame);
        measureFrame = null;
        followFrame = null;
    });

    defineExpose({
        focus,
        getState,
        isAtEnd,
        recalculate: () => measure(true),
        scrollBy,
        scrollToEnd,
        scrollToItem,
    });
</script>

<template>
    <div data-slot="message-scroller" class="relative min-h-0 w-full">
        <div class="relative flex h-full min-h-0 w-full overflow-hidden">
            <nav
                v-if="railVisible"
                ref="rail"
                :aria-label="navigationLabel"
                class="absolute inset-y-3 right-4 z-10 grid w-7 content-center py-1"
                :style="railStyle"
                data-slot="message-scroller-rail"
            >
                <button
                    v-for="(item, index) in railItems"
                    :key="item.id"
                    type="button"
                    class="relative flex w-full items-center justify-end outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    :class="
                        visibleItemIds.has(item.id) ? 'text-primary-500' : 'text-scrollbar-thumb'
                    "
                    :style="{ height: `${railItemSize}px` }"
                    :aria-label="item.ariaLabel ?? item.label"
                    :aria-current="item.id === activeItemId ? 'location' : undefined"
                    data-slot="message-scroller-rail-item"
                    @pointerenter="handlePointerEnter($event, item.id)"
                    @pointerleave="handlePointerLeave"
                    @pointerdown="handlePointerDown($event, item.id)"
                    @focus="handleFocus($event, item.id)"
                    @blur="handleBlur"
                    @click="handleRailItemSelect(item)"
                >
                    <span
                        aria-hidden="true"
                        class="block h-0.5 w-3 origin-right bg-current"
                        :style="railTickStyle(index)"
                        :data-tick-scale="railTickScale(index)"
                        data-slot="message-scroller-tick"
                    />
                </button>

                <div
                    v-if="displayedRailItem"
                    class="pointer-events-none absolute z-20 w-64"
                    :style="previewStyle"
                    aria-hidden="true"
                    data-slot="message-scroller-preview-positioner"
                >
                    <AnimatePresence mode="wait" :initial="false">
                        <motion.div
                            :key="displayedRailItem.id"
                            class="max-h-28 overflow-hidden rounded-lg border border-border-subtle bg-background-primary p-3 font-serif shadow-lg"
                            :initial="{ opacity: 0, y: 4 }"
                            :animate="{ opacity: 1, y: 0 }"
                            :exit="{
                                opacity: 0,
                                y: -2,
                                transition: reducedMotion ? { duration: 0 } : transitions.quick,
                            }"
                            :transition="reducedMotion ? { duration: 0 } : transitions.fast"
                            data-slot="message-scroller-preview"
                        >
                            <p class="truncate text-compact font-medium text-text-primary">
                                {{ displayedRailItem.label }}
                            </p>
                            <p
                                v-if="displayedRailItem.description"
                                class="mt-1 line-clamp-3 text-caption leading-5 text-text-secondary"
                                data-slot="message-scroller-preview-description"
                            >
                                {{ displayedRailItem.description }}
                            </p>
                        </motion.div>
                    </AnimatePresence>
                </div>
            </nav>

            <div class="min-h-0 min-w-0 flex-1">
                <section
                    ref="viewport"
                    tabindex="0"
                    :aria-label="label"
                    :class="viewportClasses"
                    :style="[{ overflowAnchor: 'none' }, viewportStyle]"
                    @scroll.passive="handleScroll"
                    @wheel.passive="handleWheel"
                    @touchstart.passive="handleTouchStart"
                    @touchmove.passive="handleTouchMove"
                    @keydown="handleViewportKeyboard"
                >
                    <div
                        ref="content"
                        role="log"
                        aria-live="polite"
                        aria-relevant="additions text"
                        :aria-busy="busy"
                        :class="contentClasses"
                        data-slot="message-scroller-content"
                    >
                        <slot />
                    </div>
                </section>
            </div>
        </div>
    </div>
</template>
