import { computed, nextTick, type Ref, ref, watch } from 'vue';

import {
    RESULT_COMPACT_ROW_HEIGHT,
    RESULT_LIST_COLLAPSED_ROWS,
    RESULT_LIST_EXPANDED_ROWS,
    RESULT_LIST_ROW_HEIGHT,
    RESULT_VIEWPORT_PADDING,
} from '@/components/ui/result-panel/layout';
import {
    nextResultIndex,
    resultExpansionAfterNavigation,
    revealResultRange,
} from '@/components/ui/result-panel/navigation';

export type ViewMode = 'grid' | 'list';

export const BASE_GAP_PX = 8; // 网格默认间距（px）
export const MIN_GAP_PX = 4; // 网格允许的最小间距（px）
export const ITEM_SIZE_PX = 88; // 网格项高度和最小列宽（px）
export const LIST_ROW_HEIGHT_PX = RESULT_LIST_ROW_HEIGHT;
export const LIST_ROW_GAP_PX = 0; // 列表视图行间距（px）
export const COLLAPSED_VISIBLE_ROWS = 2; // 折叠态可见行数
export const EXPANDED_VISIBLE_ROWS = 4; // 展开态可见行数

const MIN_EDGE_SPACE_PX = MIN_GAP_PX; // 面板左右最小留白（px）
const MAX_COLUMNS = 7; // 网格列数上限，避免布局过密
const DEFAULT_EDGE_SPACE_PX = RESULT_VIEWPORT_PADDING; // 默认左右留白（px）
// 折叠态下的默认面板最大高度（px）。
const DEFAULT_MAX_HEIGHT_PX =
    2 * DEFAULT_EDGE_SPACE_PX +
    COLLAPSED_VISIBLE_ROWS * ITEM_SIZE_PX +
    (COLLAPSED_VISIBLE_ROWS - 1) * BASE_GAP_PX;

// 列表模式下的默认面板最大高度（px）。
const LIST_COLLAPSED_VISIBLE_ROWS = RESULT_LIST_COLLAPSED_ROWS;
const LIST_EXPANDED_VISIBLE_ROWS = RESULT_LIST_EXPANDED_ROWS;
const LIST_DEFAULT_MAX_HEIGHT_PX =
    2 * DEFAULT_EDGE_SPACE_PX + LIST_COLLAPSED_VISIBLE_ROWS * LIST_ROW_HEIGHT_PX;

interface UseLayoutOptions {
    isOpen: Ref<boolean>;
    results: Readonly<Ref<readonly unknown[]>>;
    highlightedIndex: Ref<number>;
    scrollRef: Ref<HTMLElement | null>;
    compact?: Readonly<Ref<boolean>>;
    maxHeight?: Readonly<Ref<number | undefined>>;
}

/**
 * 快捷面板布局计算。
 * 负责网格列数/间距/高度同步，以及键盘高亮滚动对齐。
 *
 * @param options 布局计算依赖项与滚动容器引用。
 * @returns 布局状态、样式数据和键盘导航方法。
 */
export function useLayout(options: UseLayoutOptions) {
    const { isOpen, results, highlightedIndex, scrollRef } = options;

    // 1. 视图模式与布局状态
    const preferredViewMode = ref<ViewMode>('grid');
    const viewMode = computed({
        get: () => (options.compact?.value ? ('list' as const) : preferredViewMode.value),
        set: (mode: ViewMode) => {
            if (!options.compact?.value) preferredViewMode.value = mode;
        },
    });
    const gridColumns = ref(1);
    const gridGap = ref(BASE_GAP_PX);
    const edgeSpace = ref(DEFAULT_EDGE_SPACE_PX);
    const visibleRows = ref(COLLAPSED_VISIBLE_ROWS);
    const selectionMaxHeight = computed(() => {
        if (!isOpen.value || results.value.length === 0) {
            return viewMode.value === 'list' ? LIST_DEFAULT_MAX_HEIGHT_PX : DEFAULT_MAX_HEIGHT_PX;
        }
        if (viewMode.value === 'list') {
            const totalRows = results.value.length;
            const effectiveRows = Math.max(
                1,
                options.compact?.value ? totalRows : Math.min(visibleRows.value, totalRows)
            );
            return (
                2 * DEFAULT_EDGE_SPACE_PX +
                effectiveRows * currentRowHeight() +
                (effectiveRows - 1) * LIST_ROW_GAP_PX
            );
        }
        const columns = Math.max(gridColumns.value, 1);
        const totalRows = Math.max(1, Math.ceil(results.value.length / columns));
        const effectiveRows = Math.max(1, Math.min(visibleRows.value, totalRows));
        return (
            2 * edgeSpace.value + effectiveRows * ITEM_SIZE_PX + (effectiveRows - 1) * gridGap.value
        );
    });

    const gridStyle = computed(() => ({
        gridTemplateColumns: `repeat(${Math.max(gridColumns.value, 1)}, minmax(0, 1fr))`,
        gap: `${gridGap.value}px`,
    }));

    // 2. 视图模式切换
    /**
     * 切换网格/列表视图模式。
     *
     * @returns void
     */
    function toggleViewMode() {
        if (options.compact?.value) return;
        const expanded = visibleRows.value > collapsedRows();
        viewMode.value = viewMode.value === 'grid' ? 'list' : 'grid';
        visibleRows.value = expanded ? expandedRows() : collapsedRows();
        updateLayout();
        if (highlightedIndex.value >= 0) {
            scrollHighlightedIntoView();
        }
    }

    /**
     * 获取当前模式下的行高。
     *
     * @returns 行高（px）。
     */
    function currentRowHeight(): number {
        return options.compact?.value
            ? RESULT_COMPACT_ROW_HEIGHT
            : viewMode.value === 'list'
              ? LIST_ROW_HEIGHT_PX
              : ITEM_SIZE_PX;
    }

    /**
     * 获取当前模式下的行间距。
     *
     * @returns 行间距（px）。
     */
    function currentRowGap(): number {
        return viewMode.value === 'list' ? LIST_ROW_GAP_PX : gridGap.value;
    }

    function collapsedRows() {
        return viewMode.value === 'list' ? LIST_COLLAPSED_VISIBLE_ROWS : COLLAPSED_VISIBLE_ROWS;
    }

    function expandedRows() {
        return viewMode.value === 'list' ? LIST_EXPANDED_VISIBLE_ROWS : EXPANDED_VISIBLE_ROWS;
    }

    function handleWheel(event: WheelEvent) {
        if (
            options.compact?.value ||
            !isOpen.value ||
            event.ctrlKey ||
            event.deltaY <= 0 ||
            Math.abs(event.deltaX) > event.deltaY ||
            visibleRows.value > collapsedRows()
        )
            return;
        const columns = viewMode.value === 'list' ? 1 : Math.max(gridColumns.value, 1);
        if (results.value.length <= columns * visibleRows.value) return;
        // The first downward gesture reveals the next batch without moving the existing rows.
        setVisibleRows(expandedRows());
        event.preventDefault();
    }

    // 3. 布局计算
    /**
     * 设置可见行数，并限制在折叠行数与展开行数之间。
     *
     * @param rows 期望设置的可见行数。
     * @returns void
     */
    function setVisibleRows(rows: number) {
        visibleRows.value = Math.max(collapsedRows(), Math.min(rows, expandedRows()));
    }

    /**
     * 重置布局状态到默认值。
     *
     * @returns void
     */
    function resetLayoutState() {
        gridColumns.value = 1;
        gridGap.value = BASE_GAP_PX;
        edgeSpace.value = DEFAULT_EDGE_SPACE_PX;
        visibleRows.value = collapsedRows();
    }

    /**
     * 基于容器宽度更新网格列数、间距和面板尺寸。
     *
     * @returns void
     */
    function updateLayout() {
        if (!isOpen.value || results.value.length === 0) {
            resetLayoutState();
            return;
        }

        if (viewMode.value === 'list') {
            gridColumns.value = 1;
            edgeSpace.value = DEFAULT_EDGE_SPACE_PX;
            return;
        }

        const scrollWidth = scrollRef.value?.clientWidth ?? 0;
        const panelWidth = scrollRef.value?.parentElement?.clientWidth ?? 0;
        const availableWidth = scrollWidth || panelWidth;
        if (availableWidth <= 0) return;

        // 根据容器宽度动态计算列数，并限制最大列数避免视觉过密。
        const fitColumns = Math.max(
            1,
            Math.floor((availableWidth - BASE_GAP_PX) / (ITEM_SIZE_PX + BASE_GAP_PX))
        );
        // 列数按可用宽度决定，不再被结果数截断。
        // 每列均分可用宽度，不满一行的结果仍从左侧开始排布。
        const columns = Math.min(fitColumns, MAX_COLUMNS);

        let gap = BASE_GAP_PX;
        const requiredWidthAtBaseGap = columns * ITEM_SIZE_PX + (columns + 1) * BASE_GAP_PX;
        if (requiredWidthAtBaseGap > availableWidth) {
            // 空间不足时压缩 gap，但不低于最小值，保证点击区域可分辨。
            const fittedGap = (availableWidth - columns * ITEM_SIZE_PX) / (columns + 1);
            gap = Math.max(fittedGap, MIN_GAP_PX);
        }
        const edge = Math.max(gap, MIN_EDGE_SPACE_PX);
        gridColumns.value = columns;
        gridGap.value = gap;
        edgeSpace.value = edge;
    }

    /**
     * 下一次 DOM 更新后同步布局，确保读取到最新尺寸。
     *
     * @returns Promise<void>
     */
    async function syncLayout() {
        await nextTick();
        updateLayout();
        // The search queue must not wait for a frame from a hidden/occluded WebView.
        await nextTick();
    }

    // 3. 高亮滚动与键盘导航
    /**
     * 将当前高亮项滚动到可见区域内，并按行对齐。
     *
     * @returns Promise<void>
     */
    function scrollHighlightedIntoView() {
        if (highlightedIndex.value < 0) return;
        const scrollContainer = scrollRef.value;
        if (!scrollContainer) return;

        requestAnimationFrame(() => {
            if (highlightedIndex.value < 0 || scrollContainer.clientHeight <= 0) return;
            // The shared picker can be shorter than the requested row count.
            // Measure the committed viewport after layout instead of assuming expanded rows fit.
            const columns = viewMode.value === 'list' ? 1 : Math.max(gridColumns.value, 1);
            const rowHeight = currentRowHeight();
            const rowStride = rowHeight + Math.max(currentRowGap(), 0);
            const padding = options.compact?.value ? 0 : edgeSpace.value;
            const targetTop = padding + Math.floor(highlightedIndex.value / columns) * rowStride;
            const targetBottom = targetTop + rowHeight;
            revealResultRange(scrollContainer, targetTop, targetBottom, padding);
        });
    }

    /**
     * 按方向移动高亮项，并在必要时展开更多可见行。
     * highlightedIndex 为 -1 表示"无高亮"状态：
     * - down 从 -1 激活首项；left/right/up 在 -1 时忽略（不消费事件）。
     * - up 从第一排返回 -1，实现"去激活"语义。
     *
     * @param direction 高亮移动方向。
     * @returns Whether result navigation consumed the direction.
     */
    function moveSelection(direction: 'up' | 'down' | 'left' | 'right') {
        if (!isOpen.value || results.value.length === 0) return false;

        const activeColumns = viewMode.value === 'list' ? 1 : Math.max(gridColumns.value, 1);
        const currentIndex = highlightedIndex.value;
        const nextIndex = nextResultIndex(
            currentIndex,
            results.value.length,
            direction,
            activeColumns,
            !options.compact?.value
        );
        if (nextIndex === null) return false;

        const initialRows = collapsedRows();
        const expanded = visibleRows.value > initialRows;
        const nextExpanded = resultExpansionAfterNavigation({
            expanded,
            currentIndex,
            nextIndex,
            direction,
            collapsedRows: initialRows,
            columns: activeColumns,
        });
        if (!options.compact?.value && expanded !== nextExpanded) {
            // Preserve the current row's position while revealing the second batch.
            const container = scrollRef.value;
            const scrollTop = container?.scrollTop ?? 0;
            setVisibleRows(nextExpanded ? expandedRows() : initialRows);
            updateLayout();
            if (container && nextExpanded) {
                requestAnimationFrame(() => (container.scrollTop = scrollTop));
            }
        }

        highlightedIndex.value = nextIndex;
        if (nextIndex >= 0) {
            void scrollHighlightedIntoView();
        }
        return true;
    }

    watch(
        () => options.compact?.value,
        () => {
            resetLayoutState();
            updateLayout();
        }
    );

    return {
        viewMode,
        rowHeight: computed(currentRowHeight),
        gridColumns,
        gridGap,
        visibleRows,
        selectionMaxHeight,
        edgeSpace,
        gridStyle,
        toggleViewMode,
        setVisibleRows,
        resetLayoutState,
        updateLayout,
        syncLayout,
        handleWheel,
        moveSelection,
        scrollHighlightedIntoView,
    };
}
