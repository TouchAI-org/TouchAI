import type { QuickShortcutItem } from '@services/NativeService';
import { computed, nextTick, type Ref, ref } from 'vue';

export type ViewMode = 'grid' | 'list';

export const BASE_GAP_PX = 8; // 网格默认间距（px）
export const MIN_GAP_PX = 4; // 网格允许的最小间距（px）
export const ITEM_SIZE_PX = 88; // 单个结果项方块尺寸（px）
export const LIST_ROW_HEIGHT_PX = 40; // 列表视图行高（px）
export const LIST_ROW_GAP_PX = 0; // 列表视图行间距（px）
export const COLLAPSED_VISIBLE_ROWS = 2; // 折叠态可见行数
export const EXPANDED_VISIBLE_ROWS = 4; // 展开态可见行数

const MIN_EDGE_SPACE_PX = MIN_GAP_PX; // 面板左右最小留白（px）
const MAX_COLUMNS = 7; // 网格列数上限，避免布局过密
const DEFAULT_EDGE_SPACE_PX = BASE_GAP_PX; // 默认左右留白（px）
// 折叠态下的默认面板最大高度（px）。
const DEFAULT_MAX_HEIGHT_PX =
    2 * DEFAULT_EDGE_SPACE_PX +
    COLLAPSED_VISIBLE_ROWS * ITEM_SIZE_PX +
    (COLLAPSED_VISIBLE_ROWS - 1) * BASE_GAP_PX;

// 列表模式下的默认面板最大高度（px）。
const LIST_COLLAPSED_VISIBLE_ROWS = 8;
const LIST_EXPANDED_VISIBLE_ROWS = 15;
const LIST_DEFAULT_MAX_HEIGHT_PX =
    2 * DEFAULT_EDGE_SPACE_PX + LIST_COLLAPSED_VISIBLE_ROWS * LIST_ROW_HEIGHT_PX;

interface UseLayoutOptions {
    isOpen: Ref<boolean>;
    results: Ref<QuickShortcutItem[]>;
    highlightedIndex: Ref<number>;
    scrollRef: Ref<HTMLElement | null>;
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
    const viewMode = ref<ViewMode>('grid');
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
            const effectiveRows = Math.max(1, Math.min(visibleRows.value, totalRows));
            return (
                2 * DEFAULT_EDGE_SPACE_PX +
                effectiveRows * LIST_ROW_HEIGHT_PX +
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

    const scrollStyle = computed(() => ({
        '--quick-edge-space': `${edgeSpace.value}px`,
        '--quick-selection-max-height': `${selectionMaxHeight.value}px`,
    }));

    const gridStyle = computed(() => ({
        gridTemplateColumns: `repeat(${Math.max(gridColumns.value, 1)}, ${ITEM_SIZE_PX}px)`,
        gap: `${gridGap.value}px`,
    }));

    // 2. 视图模式切换
    /**
     * 切换网格/列表视图模式。
     *
     * @returns void
     */
    function toggleViewMode() {
        viewMode.value = viewMode.value === 'grid' ? 'list' : 'grid';
        visibleRows.value =
            viewMode.value === 'list' ? LIST_EXPANDED_VISIBLE_ROWS : EXPANDED_VISIBLE_ROWS;
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
        return viewMode.value === 'list' ? LIST_ROW_HEIGHT_PX : ITEM_SIZE_PX;
    }

    /**
     * 获取当前模式下的行间距。
     *
     * @returns 行间距（px）。
     */
    function currentRowGap(): number {
        return viewMode.value === 'list' ? LIST_ROW_GAP_PX : gridGap.value;
    }

    // 3. 布局计算
    /**
     * 设置可见行数，并限制在折叠行数与展开行数之间。
     *
     * @param rows 期望设置的可见行数。
     * @returns void
     */
    function setVisibleRows(rows: number) {
        if (viewMode.value === 'list') {
            visibleRows.value = Math.max(
                LIST_COLLAPSED_VISIBLE_ROWS,
                Math.min(rows, LIST_EXPANDED_VISIBLE_ROWS)
            );
        } else {
            visibleRows.value = Math.max(
                COLLAPSED_VISIBLE_ROWS,
                Math.min(rows, EXPANDED_VISIBLE_ROWS)
            );
        }
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
        if (viewMode.value === 'list') {
            visibleRows.value = LIST_COLLAPSED_VISIBLE_ROWS;
        } else {
            setVisibleRows(COLLAPSED_VISIBLE_ROWS);
        }
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
        const viewportWidth = scrollRef.value?.ownerDocument?.documentElement?.clientWidth ?? 0;
        const windowWidth = typeof window !== 'undefined' ? window.innerWidth : 0;
        const availableWidth = Math.max(
            scrollWidth,
            panelWidth,
            viewportWidth > 0 ? viewportWidth - 32 : 0,
            windowWidth > 0 ? windowWidth - 32 : 0
        );
        if (availableWidth <= 0) return;

        // 根据容器宽度动态计算列数，并限制最大列数避免视觉过密。
        const fitColumns = Math.max(
            1,
            Math.floor((availableWidth - BASE_GAP_PX) / (ITEM_SIZE_PX + BASE_GAP_PX))
        );
        // 列数按可用宽度决定，不再被结果数截断。
        // 这样容器可以保持居中，而结果项始终从容器左侧开始排布。
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
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
                updateLayout();
                resolve();
            });
        });
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

        const activeColumns = Math.max(gridColumns.value, 1);
        const rowHeight = currentRowHeight() + Math.max(currentRowGap(), 0);
        if (rowHeight <= 0) return;

        const targetRow = Math.floor(highlightedIndex.value / activeColumns);
        const totalRows = Math.max(1, Math.ceil(results.value.length / activeColumns));
        const visRows = Math.max(1, Math.min(visibleRows.value, totalRows));
        const currentFirstRow = Math.max(Math.floor(scrollContainer.scrollTop / rowHeight), 0);

        let nextFirstRow = currentFirstRow;
        if (targetRow < currentFirstRow) {
            nextFirstRow = targetRow;
        } else if (targetRow > currentFirstRow + visRows - 1) {
            nextFirstRow = targetRow - visRows + 1;
        }

        requestAnimationFrame(() => {
            const maxScrollTop = Math.max(
                scrollContainer.scrollHeight - scrollContainer.clientHeight,
                0
            );
            const alignedScrollTop = Math.min(Math.max(nextFirstRow * rowHeight, 0), maxScrollTop);
            if (Math.abs(scrollContainer.scrollTop - alignedScrollTop) > 0.5) {
                scrollContainer.scrollTop = alignedScrollTop;
            }
        });
    }

    /**
     * 按方向移动高亮项，并在必要时展开更多可见行。
     * highlightedIndex 为 -1 表示"无高亮"状态：
     * - down 从 -1 激活首项；left/right/up 在 -1 时忽略（不消费事件）。
     * - up 从第一排返回 -1，实现"去激活"语义。
     *
     * @param direction 高亮移动方向。
     * @returns void
     */
    function moveSelection(direction: 'up' | 'down' | 'left' | 'right') {
        if (!isOpen.value || results.value.length === 0) return;

        const maxIndex = results.value.length - 1;
        const activeColumns = viewMode.value === 'list' ? 1 : Math.max(gridColumns.value, 1);
        const currentIndex = highlightedIndex.value;
        let nextIndex = currentIndex;

        const collapsedRows =
            viewMode.value === 'list' ? LIST_COLLAPSED_VISIBLE_ROWS : COLLAPSED_VISIBLE_ROWS;

        switch (direction) {
            case 'left':
                if (currentIndex < 0) return; // 无高亮时忽略
                nextIndex = Math.max(nextIndex - 1, 0);
                break;
            case 'right':
                if (currentIndex < 0) return; // 无高亮时忽略
                nextIndex = Math.min(nextIndex + 1, maxIndex);
                break;
            case 'up':
                if (currentIndex < 0) return; // 无高亮时忽略
                if (currentIndex < activeColumns) {
                    // 第一排向上 → 去激活高亮
                    nextIndex = -1;
                } else {
                    nextIndex = Math.max(nextIndex - activeColumns, 0);
                }
                // 向上回到折叠区域或去激活时自动收缩。
                if (visibleRows.value !== collapsedRows) {
                    const shouldCollapse =
                        nextIndex < 0 || Math.floor(nextIndex / activeColumns) < collapsedRows;
                    if (shouldCollapse) {
                        setVisibleRows(collapsedRows);
                        updateLayout();
                    }
                }
                break;
            case 'down':
                if (currentIndex < 0) {
                    // 无高亮 → 激活首项
                    nextIndex = 0;
                } else {
                    const currentRow = Math.floor(currentIndex / activeColumns);
                    nextIndex = Math.min(nextIndex + activeColumns, maxIndex);
                    if (
                        visibleRows.value === collapsedRows &&
                        currentRow >= collapsedRows - 1 &&
                        nextIndex > currentIndex
                    ) {
                        // 展开前记录当前高亮行的视觉位置，展开后恢复，避免内容跳动。
                        const container = scrollRef.value;
                        const rowTop =
                            currentRow * (currentRowHeight() + Math.max(currentRowGap(), 0));
                        const offsetInViewport = container ? rowTop - container.scrollTop : 0;
                        setVisibleRows(
                            viewMode.value === 'list'
                                ? LIST_EXPANDED_VISIBLE_ROWS
                                : EXPANDED_VISIBLE_ROWS
                        );
                        updateLayout();
                        if (container) {
                            requestAnimationFrame(() => {
                                container.scrollTop = rowTop - offsetInViewport;
                            });
                        }
                    }
                }
                break;
        }

        highlightedIndex.value = nextIndex;
        if (nextIndex >= 0) {
            void scrollHighlightedIntoView();
        }
    }

    return {
        viewMode,
        gridColumns,
        gridGap,
        visibleRows,
        selectionMaxHeight,
        scrollStyle,
        gridStyle,
        toggleViewMode,
        setVisibleRows,
        resetLayoutState,
        updateLayout,
        syncLayout,
        moveSelection,
        scrollHighlightedIntoView,
    };
}
