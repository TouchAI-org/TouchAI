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

    import { resolveRailLayout } from './railLayout';
    import { resolveRailItemAtOffset } from './railRange';
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
    /** 布局收敛窗口：虚拟列表测量后的自动补偿也算“非用户滚动”。 */
    const LAYOUT_SETTLE_MS = 600;
    /** 视为“第三方布局补偿”的最大离底距离（再大就当用户真的走开了）。 */
    const FOLLOW_DRIFT_MAX_PX = 48;
    /** 距离用户最近一次输入多久之后才允许自动复位。 */
    const USER_INPUT_GRACE_MS = 400;
    /** 自动复位的最小间隔。 */
    const FOLLOW_REPAIR_INTERVAL_MS = 400;
    const RAIL_VERTICAL_PADDING = 8;
    const PREVIEW_MAX_HEIGHT = 112;
    const PREVIEW_HALF_HEIGHT = PREVIEW_MAX_HEIGHT / 2;
    const RAIL_WAVE_SCALES = [1.5, 1.28, 1.12, 1.02] as const;
    const RAIL_WAVE_STEP_DELAY = 0.012;

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
        /**
         * 自定义跳转实现。
         *
         * 默认按 DOM 查找目标元素；消息列表虚拟化后，屏幕外条目没有 DOM，
         * 由调用方改成按索引跳转（virtua 的 `scrollToIndex`）。
         */
        itemScrollTarget?: (id: string, options: MessageScrollerScrollOptions) => boolean;
        /** 条目在内容坐标系中的区间，用于导航轨高亮（一条消息可能跨多屏）。 */
        itemRanges?: (id: string) => { top: number; bottom: number } | null;
        /**
         * 导航轨顶部要避开的区域（像素）。
         *
         * 窗口顶部有一条可拖动区（工具栏），它盖在内容之上；轨道如果从容器顶部开始，
         * 最上面几个点会落在拖动区里而无法点击。
         */
        railInsetTop?: number;
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
        itemScrollTarget: undefined,
        itemRanges: undefined,
        railInsetTop: 0,
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

    const displayItems = computed(() =>
        props.items.map((item) => {
            const preview = splitText(item.label || props.emptyLabel, PREVIEW_TITLE_LENGTH);
            const description = item.description
                ? truncateText(item.description, PREVIEW_DESCRIPTION_LENGTH)
                : preview.remainder
                  ? truncateText(preview.remainder, PREVIEW_DESCRIPTION_LENGTH)
                  : undefined;

            return {
                ...item,
                label: preview.label,
                description,
            };
        })
    );

    const displayedItemId = computed(
        () => hoveredItemId.value ?? pinnedItemId.value ?? focusedItemId.value
    );

    const displayedItem = computed(
        () => displayItems.value.find((item) => item.id === displayedItemId.value) ?? null
    );

    const displayedItemIndex = computed(() =>
        displayItems.value.findIndex((item) => item.id === displayedItemId.value)
    );

    const railVisible = computed(
        () => props.navigation === 'rail' && overflowing.value && displayItems.value.length > 1
    );

    const railItemSize = computed(() => {
        return resolveRailLayout({
            itemCount: displayItems.value.length,
            availableHeight: Math.max(0, railHeight.value - RAIL_VERTICAL_PADDING),
        }).itemSize;
    });

    const railStyle = computed(() => ({
        top: `${(props.railInsetTop ?? 0) + RAIL_VERTICAL_PADDING / 2}px`,
        bottom: `${RAIL_VERTICAL_PADDING / 2}px`,
        gridTemplateRows: `repeat(${displayItems.value.length}, ${railItemSize.value}px)`,
    }));

    const previewStyle = computed(() => {
        if (displayedItemIndex.value < 0) return {};
        const centerOffset =
            (displayedItemIndex.value - (displayItems.value.length - 1) / 2) * railItemSize.value;
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
        if (displayedItemIndex.value < 0) return Number.POSITIVE_INFINITY;
        return Math.abs(index - displayedItemIndex.value);
    }

    function railTickScale(index: number): number {
        return RAIL_WAVE_SCALES[railTickDistance(index)] ?? 1;
    }

    function railTickTransition(index: number) {
        const distance = railTickDistance(index);
        return {
            ...transitions.value.quick,
            delay:
                reducedMotion.value || !Number.isFinite(distance)
                    ? 0
                    : distance * RAIL_WAVE_STEP_DELAY,
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
    let lastScrollHeight = 0;
    let lastScrollTop = 0;
    /** 布局收敛截止时间：此前的 scrollTop 变化不计入用户意图。 */
    let layoutSettleUntil = 0;
    /** 最近一次真实输入（滚轮/触摸/键盘/拖拽）的时间。 */
    let lastUserInputAt = 0;
    /** 最近一次“小幅跟随复位”的时间，用于限速。 */
    let lastFollowRepairAt = 0;
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

        // 有区间信息时按内容坐标系判断重叠，而不是查 DOM：
        // 虚拟列表里屏幕外的条目没有元素，靠 DOM 只能高亮一条。
        // 没有可用区间时（例如该会话不虚拟化）回落到 DOM 判定。
        if (props.itemRanges && displayItems.value.some((item) => props.itemRanges?.(item.id))) {
            const viewTop = element.scrollTop;
            const viewBottom = viewTop + element.clientHeight;
            for (const item of displayItems.value) {
                const range = props.itemRanges(item.id);
                if (!range) continue;
                if (range.bottom > viewTop && range.top < viewBottom) {
                    nextIds.add(item.id);
                }
            }

            if (!sameIds(visibleItemIds.value, nextIds)) {
                visibleItemIds.value = nextIds;
            }
            return;
        }

        for (const item of displayItems.value) {
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
            activeItemId.value = displayItems.value[0]?.id ?? '';
            visibleItemIds.value = new Set();
            return;
        }

        const viewportRect = element.getBoundingClientRect();
        updateVisibleItems(element, viewportRect);

        if (element.scrollTop <= props.followThreshold) {
            activeItemId.value = displayItems.value[0]?.id ?? '';
            return;
        }

        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        if (distance <= props.followThreshold) {
            activeItemId.value = displayItems.value[displayItems.value.length - 1]?.id ?? '';
            return;
        }

        const viewportCenter = viewportRect.top + viewportRect.height / 2;

        // 有区间信息时按内容坐标系算“当前所在 turn”：
        // 长回答往往独占多屏，靠 DOM 中心点会错判成上一条或下一条。
        if (props.itemRanges) {
            const viewCenter = element.scrollTop + element.clientHeight / 2;
            const nextId = resolveRailItemAtOffset(
                displayItems.value,
                props.itemRanges,
                viewCenter
            );
            // 区间不可用（例如该会话未虚拟化）时回落到下面的 DOM 判定。
            if (nextId !== null) {
                if (activeItemId.value !== nextId) {
                    activeItemId.value = nextId;
                }
                return;
            }
        }

        let nearestId = displayItems.value[0]?.id ?? '';
        let nearestDistance = Number.POSITIVE_INFINITY;

        for (const item of displayItems.value) {
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

        // 同步“已知位置”基准：下一次 scroll 事件靠它判断方向。
        // 放在 measure 里而不是只放在 handleScroll 里，是因为滚动也可能由
        // 内容增长、程序性定位引起，那些不应污染基准。
        lastScrollTop = state.scrollTop;
        lastScrollHeight = state.scrollHeight;

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
                // 不要在这里重算 follow：这是程序性滚动的收尾，如果内容刚变高、
                // 滚动还没跟上，“离底很远”会被误判成用户上滚，把跟随关掉，
                // 结果就是视图停在半路、看起来往上漂了一点。
                scheduleMeasure(false);
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
        const align = options.align ?? 'center';

        // 虚拟化列表：目标可能未挂载，交给调用方按索引处理。
        // 调用方无法处理（例如本条消息不虚拟化）时，继续走下面的 DOM 查找。
        if (props.itemScrollTarget) {
            const scrolled = props.itemScrollTarget(id, options);
            if (scrolled) {
                // 一次性定位：不在这里重算跟随，也不要标记为程序性滚动的长窗口，
                // 否则后续测量会把“滚动中”当成用户意图而反复回弹。
                setFollowing(align === 'end');
                return true;
            }
        }

        const element = viewport.value;
        const target = findItemElement(id);
        if (!element || !target) return false;

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

    function nowMs(): number {
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }

    /**
     * 跟随意图下，延迟把视图扭回底部。
     *
     * 第三方（代码块库根据实际高度做 scrollTop 锚定补偿）会在我们贴底之后
     * 再把位置推开几像素。这里在 resize 后等一拍再补一次，到底即停；
     * **不能**在 scroll 事件里反复补，否则会和补偿互推，形成肉眼可见的抖动。
     */
    function reassertFollow(): void {
        if (followFrame !== null) {
            return;
        }

        let attempts = 2;
        const step = () => {
            followFrame = null;
            if (!props.followOutput || !following.value) {
                return;
            }

            const element = viewport.value;
            if (!element) {
                return;
            }

            const distance = Math.max(
                0,
                element.scrollHeight - element.scrollTop - element.clientHeight
            );
            if (distance <= END_TOLERANCE || attempts <= 0) {
                return;
            }

            attempts -= 1;
            scrollToEnd('auto');
            followFrame = requestFrame(step);
        };

        followFrame = requestFrame(step);
    }

    function interruptProgrammaticScroll(): void {
        programmaticScroll = false;
        if (programmaticScrollTimer) {
            clearTimeout(programmaticScrollTimer);
            programmaticScrollTimer = null;
        }
    }

    function handleScroll(): void {
        const element = viewport.value;
        if (!element) {
            return;
        }

        // 滚动事件只负责“回到底部就恢复跟随”。
        //
        // 停止跟随不在这里判：内容变高（流式输出、虚拟列表挂载）会同时改变
        // scrollHeight 和“离底距离”，靠几何量推断会把增长误判成用户上滚，
        // 结果就是视图停在半路、看起来往上漂了一点。
        // 真正的用户意图由 wheel / touch / 键盘 / 拖拽滚动条这些**输入事件**决定。
        if (!programmaticScroll) {
            const grew = element.scrollHeight !== lastScrollHeight;
            const distance = Math.max(
                0,
                element.scrollHeight - element.scrollTop - element.clientHeight
            );
            const recentInput = nowMs() - lastUserInputAt <= USER_INPUT_GRACE_MS;

            if (distance <= props.followThreshold) {
                // 回到底部：恢复跟随。
                setFollowing(true);
            } else if (
                !grew &&
                element.scrollTop < lastScrollTop - 1 &&
                nowMs() > layoutSettleUntil
            ) {
                const drift = lastScrollTop - element.scrollTop;

                if (recentInput || drift > FOLLOW_DRIFT_MAX_PX) {
                    // 有输入事件，或一下子就走很远：用户上滚（含拖原生滚动条）。
                    setFollowing(false);
                } else if (
                    props.followOutput &&
                    following.value &&
                    nowMs() - lastFollowRepairAt > FOLLOW_REPAIR_INTERVAL_MS
                ) {
                    // 无输入却小幅上移：第三方（代码块库）测量后的锚定补偿。
                    // 补一次到宁，限速避免与其互推。
                    lastFollowRepairAt = nowMs();
                    scrollToEnd('auto');
                }
            }
        }

        lastScrollTop = element.scrollTop;
        lastScrollHeight = element.scrollHeight;
        scheduleMeasure(false);
    }

    function handleWheel(event: WheelEvent): void {
        interruptProgrammaticScroll();
        lastUserInputAt = nowMs();
        if (event.deltaY < 0) setFollowing(false);
    }

    function handleTouchStart(): void {
        interruptProgrammaticScroll();
        lastUserInputAt = nowMs();
        touchStartScrollTop = viewport.value?.scrollTop ?? 0;
    }

    function handleTouchMove(): void {
        lastUserInputAt = nowMs();
        const element = viewport.value;
        if (element && element.scrollTop < touchStartScrollTop) {
            setFollowing(false);
        }
    }

    function handleViewportKeyboard(event: KeyboardEvent): void {
        const scrollKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
        if (scrollKeys.includes(event.key)) {
            interruptProgrammaticScroll();
            lastUserInputAt = nowMs();
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
        // 虚拟列表测量完会自行补偿 scrollTop：这属于布局，不是用户意图。
        // 用一个短窗口把这些位移排除在“用户上滚”判定之外，
        // 否则打开会话时会因一次几十像素的补偿就把跟随关掉、按钮冒出来。
        layoutSettleUntil = nowMs() + LAYOUT_SETTLE_MS;
        scheduleMeasure(false);
        if (!props.followOutput || !following.value) return;
        if (followFrame !== null) cancelFrame(followFrame);
        followFrame = requestFrame(() => {
            followFrame = null;
            if (!props.followOutput || !following.value) return;
            scrollToEnd(defaultFollowBehavior());
            // 代码块库会在同一帧末尾再写一次 scrollTop，推迟一拍补上。
            followFrame = requestFrame(() => {
                followFrame = null;
                reassertFollow();
            });
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

    function handleRailItemSelect(item: MessageScrollerItem): void {
        emit('itemSelect', item);
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
        },
        { deep: true }
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
        getViewportElement: () => viewport.value,
        isAtEnd,
        recalculate: () => measure(true),
        scrollBy,
        scrollToEnd,
        scrollToItem,
        setFollowing,
    });
</script>

<template>
    <div data-slot="message-scroller" class="relative min-h-0 w-full">
        <div class="relative flex h-full min-h-0 w-full overflow-hidden">
            <nav
                v-if="railVisible"
                ref="rail"
                :aria-label="navigationLabel"
                class="absolute right-4 z-10 grid w-7 content-center py-1"
                :style="railStyle"
                data-slot="message-scroller-rail"
            >
                <button
                    v-for="(item, index) in displayItems"
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
                    <motion.span
                        aria-hidden="true"
                        class="block h-0.5 w-3 origin-right bg-current"
                        :animate="{
                            scaleX: railTickScale(index),
                        }"
                        :transition="reducedMotion ? { duration: 0 } : railTickTransition(index)"
                        :data-tick-scale="railTickScale(index)"
                        data-slot="message-scroller-tick"
                    />
                </button>

                <div
                    v-if="displayedItem"
                    class="pointer-events-none absolute z-20 w-64"
                    :style="previewStyle"
                    aria-hidden="true"
                    data-slot="message-scroller-preview-positioner"
                >
                    <AnimatePresence mode="wait" :initial="false">
                        <motion.div
                            :key="displayedItem.id"
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
                                {{ displayedItem.label }}
                            </p>
                            <p
                                v-if="displayedItem.description"
                                class="mt-1 line-clamp-3 text-caption leading-5 text-text-secondary"
                                data-slot="message-scroller-preview-description"
                            >
                                {{ displayedItem.description }}
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
                        <!--
                            虚拟化插槽：传入后由外部（virtua）负责有界挂载与按索引跳转，
                            这里只提供滚动视口与导航轨。
                        -->
                        <slot v-if="$slots.virtualized" name="virtualized" />
                        <slot v-else />
                    </div>
                </section>
            </div>
        </div>
    </div>
</template>
