// Ported from https://www.fluidfunctionalism.com/r/use-proximity-hover.json
// Upstream: registry/default/hooks/use-proximity-hover.ts
// Adapted: React useState/useRef/useCallback → Vue refs/composables.

import { onMounted, onUnmounted, type Ref, ref, watch } from 'vue';

export interface ItemRect {
    top: number;
    height: number;
    left: number;
    width: number;
}

export interface UseProximityHoverOptions {
    axis?: 'x' | 'y';
}

export function useProximityHover(
    containerRef: Ref<HTMLElement | null>,
    options: UseProximityHoverOptions = {}
) {
    const { axis = 'y' } = options;
    const itemsRef = new Map<number, HTMLElement>();
    const activeIndex = ref<number | null>(null);
    const itemRects = ref<ItemRect[]>([]);
    const sessionRef = ref(0);
    let rafId: number | null = null;
    let remeasureRafId: number | null = null;

    function measureItems(): void {
        const container = containerRef.value;
        if (!container) return;
        const rects: ItemRect[] = [];
        itemsRef.forEach((element, index) => {
            rects[index] = {
                top: element.offsetTop,
                height: element.offsetHeight,
                left: element.offsetLeft,
                width: element.offsetWidth,
            };
        });
        itemRects.value = rects;
    }

    function registerItem(index: number, element: HTMLElement | null): void {
        if (element) {
            itemsRef.set(index, element);
        } else {
            itemsRef.delete(index);
        }
        if (remeasureRafId !== null) {
            cancelAnimationFrame(remeasureRafId);
        }
        remeasureRafId = requestAnimationFrame(() => {
            remeasureRafId = null;
            measureItems();
        });
    }

    function setActiveIndex(value: number | null | ((prev: number | null) => number | null)): void {
        activeIndex.value =
            typeof value === 'function'
                ? (value as (prev: number | null) => number | null)(activeIndex.value)
                : value;
    }

    function onMouseMove(e: MouseEvent): void {
        const mouseX = e.clientX;
        const mouseY = e.clientY;

        if (rafId !== null) {
            cancelAnimationFrame(rafId);
        }

        rafId = requestAnimationFrame(() => {
            rafId = null;
            const container = containerRef.value;
            if (!container) return;

            const containerRect = container.getBoundingClientRect();
            const mousePos = axis === 'x' ? mouseX : mouseY;

            let closestIndex: number | null = null;
            let closestDistance = Infinity;
            let containingIndex: number | null = null;

            const rects = itemRects.value;
            const scrollOffset = axis === 'x' ? container.scrollLeft : container.scrollTop;
            const borderOffset = axis === 'x' ? container.clientLeft : container.clientTop;
            const containerEdge = axis === 'x' ? containerRect.left : containerRect.top;
            const layoutSize = axis === 'x' ? container.offsetWidth : container.offsetHeight;
            const visualSize = axis === 'x' ? containerRect.width : containerRect.height;
            const scale = layoutSize > 0 ? visualSize / layoutSize : 1;

            for (let index = 0; index < rects.length; index++) {
                const r = rects[index];
                if (!r) continue;

                const contentPos = axis === 'x' ? r.left : r.top;
                const itemStart =
                    containerEdge + (borderOffset + contentPos - scrollOffset) * scale;
                const itemSize = (axis === 'x' ? r.width : r.height) * scale;
                const itemEnd = itemStart + itemSize;

                if (mousePos >= itemStart && mousePos <= itemEnd) {
                    containingIndex = index;
                }

                const itemCenter = itemStart + itemSize / 2;
                const distance = Math.abs(mousePos - itemCenter);

                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestIndex = index;
                }
            }

            activeIndex.value = containingIndex ?? closestIndex;
        });
    }

    function onMouseEnter(): void {
        sessionRef.value += 1;
    }

    function onMouseLeave(): void {
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        activeIndex.value = null;
    }

    onUnmounted(() => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (remeasureRafId !== null) cancelAnimationFrame(remeasureRafId);
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
    });

    let resizeObserver: ResizeObserver | null = null;
    function scheduleRemeasure(): void {
        if (remeasureRafId !== null) cancelAnimationFrame(remeasureRafId);
        remeasureRafId = requestAnimationFrame(() => {
            remeasureRafId = null;
            measureItems();
        });
    }
    onMounted(() => {
        if (typeof ResizeObserver === 'undefined') return;
        resizeObserver = new ResizeObserver(scheduleRemeasure);
    });
    watch(
        containerRef,
        (el, prev) => {
            if (!resizeObserver) return;
            if (prev) resizeObserver.unobserve(prev);
            if (el) resizeObserver.observe(el);
        },
        { immediate: true }
    );

    return {
        activeIndex,
        setActiveIndex,
        itemRects,
        sessionRef,
        handlers: { onMouseMove, onMouseEnter, onMouseLeave },
        registerItem,
        measureItems,
    };
}
