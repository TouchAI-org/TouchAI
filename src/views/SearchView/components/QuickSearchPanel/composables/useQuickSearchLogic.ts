import { type ContextMenuItem, useContextMenu } from '@composables/useContextMenu';
import { clipboardService } from '@services/ClipboardService';
import { native, type QuickShortcutItem } from '@services/NativeService';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { computed, nextTick, onMounted, onUnmounted, type Ref, ref, watch } from 'vue';

import {
    buildMatchTokens,
    type NameSegment,
    splitNameByTokens,
} from '../utils/quickSearchHighlight';
import { useAssetLoader } from './useAssetLoader';
import { COLLAPSED_VISIBLE_ROWS, useLayout } from './useLayout';
import { useQuickSearchClickStats } from './useQuickSearchClickStats';

const PAGE_SIZE = 60;
const DEBOUNCE_MS = 80;

const CONTEXT_MENU_ITEMS: ContextMenuItem[] = [
    { key: 'open-folder', label: '打开所在文件夹', icon: 'folder-open' },
    { key: 'copy-path', label: '复制路径', icon: 'copy' },
];

interface UseQuickSearchFlowOptions {
    searchQuery: Ref<string>;
    enabled: Ref<boolean>;
    emitOpenUpdate: (value: boolean) => void;
    isOpen: Ref<boolean>;
    results: Ref<QuickShortcutItem[]>;
    highlightedIndex: Ref<number>;
    itemRefs: Ref<HTMLElement[]>;
    requestId: Ref<number>;
    searchInFlight: Ref<boolean>;
    pendingQuery: Ref<string | null>;
    currentPage: Ref<number>;
    totalFiles: Ref<number>;
    totalResults: Ref<number>;
    nextOffset: Ref<number>;
    resetResultState: () => void;
    setVisibleRows: (rows: number) => void;
    syncLayout: () => Promise<void>;
    scheduleIconLoad: (reqId?: number, immediate?: boolean) => void;
    scheduleImageLoad: (reqId?: number, immediate?: boolean) => void;
    flushPendingLoads: () => void;
    resetLoadingState: () => void;
    pruneIconMaps: (force?: boolean) => void;
}

export interface UseQuickSearchDeps {
    quickSearch: Pick<typeof native.quickSearch, 'getStatus' | 'prepareIndex' | 'searchShortcuts'>;
    window: Pick<typeof native.window, 'hideSearchWindow'>;
    openPath: typeof openPath;
}

const DEFAULT_DEPS: UseQuickSearchDeps = {
    quickSearch: native.quickSearch,
    window: native.window,
    openPath,
};

interface UseQuickSearchLogicOptions {
    open: Ref<boolean>;
    searchQuery: Ref<string>;
    enabled: Ref<boolean>;
    emitOpenUpdate: (value: boolean) => void;
}

/**
 * 快速搜索流程编排。
 * 负责索引准备、查询调度、防抖串行、结果高亮与快捷项打开。
 *
 * @param options 搜索流程依赖项与回调。
 * @param deps 可注入依赖，默认使用 native 与 opener 实现。
 * @returns 搜索生命周期、结果高亮与打开行为方法集合。
 */
function useQuickSearchFlow(
    options: UseQuickSearchFlowOptions,
    deps: UseQuickSearchDeps = DEFAULT_DEPS
) {
    const {
        searchQuery,
        enabled,
        emitOpenUpdate,
        results,
        highlightedIndex,
        itemRefs,
        requestId,
        searchInFlight,
        pendingQuery,
        currentPage,
        totalFiles,
        totalResults,
        nextOffset,
        resetResultState,
        setVisibleRows,
        syncLayout,
        scheduleIconLoad,
        scheduleImageLoad,
        flushPendingLoads,
        resetLoadingState,
        pruneIconMaps,
    } = options;

    // 1. 搜索流程状态
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSearchedQuery = '';
    const clickStats = useQuickSearchClickStats();

    // 2. 名称高亮匹配
    // 高亮分段属于搜索语义，放在搜索流程 composable 内统一维护。
    const matchTokens = computed(() => buildMatchTokens(searchQuery.value));

    /**
     * 将名称按匹配命中拆分为高亮片段。
     *
     * @param name 原始名称文本。
     * @returns 供模板渲染的高亮分段列表。
     */
    function getNameSegments(name: string): NameSegment[] {
        return splitNameByTokens(name, matchTokens.value);
    }

    // 3. 索引状态与搜索调度
    /**
     * 清除输入防抖计时器。
     *
     * @returns void
     */
    function clearDebounceTimer() {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
    }

    /**
     * 刷新 native 快速搜索状态（失败仅记录日志）。
     *
     * @returns Promise<void>
     */
    async function refreshStatus() {
        try {
            await deps.quickSearch.getStatus();
        } catch (error) {
            console.warn('[QuickSearchPanel] Failed to get status:', error);
        }
    }

    /**
     * 准备或重建快速搜索索引。
     *
     * @param force 是否强制重建索引。
     * @returns Promise<void>
     */
    async function prepareIndex(force = false) {
        try {
            await deps.quickSearch.prepareIndex(force);
        } catch (error) {
            console.warn('[QuickSearchPanel] Failed to prepare index:', error);
        } finally {
            await refreshStatus();
        }
    }

    /**
     * 执行一次查询并同步面板展示状态。
     *
     * @param query 查询文本。
     * @returns Promise<void>
     */
    async function executeSearch(query: string) {
        const trimmedQuery = query.trim();
        if (!trimmedQuery) {
            close();
            return;
        }

        // 相同查询且已有结果时跳过，避免失焦恢复等场景重复搜索覆盖多页结果。
        if (trimmedQuery === lastSearchedQuery && results.value.length > 0) {
            return;
        }

        const reqId = ++requestId.value;

        try {
            const searchResult = await deps.quickSearch.searchShortcuts(trimmedQuery, PAGE_SIZE, 0);
            if (reqId !== requestId.value) return;

            if (searchQuery.value.trim() !== trimmedQuery || !enabled.value) return;

            let rankedShortcuts = searchResult.shortcuts;
            if (searchResult.shortcuts.length > 0) {
                rankedShortcuts = await clickStats.rankResults(trimmedQuery, rankedShortcuts);
                if (reqId !== requestId.value) return;
            }

            const mergedResults = [...rankedShortcuts, ...searchResult.files];

            if (mergedResults.length === 0) {
                close();
                return;
            }

            emitOpenUpdate(true);
            results.value = mergedResults;
            lastSearchedQuery = trimmedQuery;
            totalFiles.value = searchResult.total_files;
            totalResults.value = searchResult.total_results;
            nextOffset.value = searchResult.next_offset;
            currentPage.value = 0;
            itemRefs.value = [];
            resetLoadingState();
            highlightedIndex.value = -1;
            setVisibleRows(COLLAPSED_VISIBLE_ROWS);
            await syncLayout();
            scheduleIconLoad(reqId, false);
            scheduleImageLoad(reqId, false);
        } catch (error) {
            console.error('[QuickSearchPanel] Failed to search shortcuts:', error);
            if (reqId === requestId.value) {
                close();
            }
        }
    }

    /**
     * 跳转到指定页码重新执行当前查询。
     *
     * @param page 目标页码（0-indexed）。
     * @returns void
     */
    function goToPage() {
        const query = searchQuery.value.trim();
        if (!query) return;
        void executeSearch(query);
    }

    /**
     * 串行执行搜索任务，合并连续输入带来的重复请求。
     *
     * @param query 初始查询文本。
     * @returns Promise<void>
     */
    async function runSearchLoop(query: string) {
        let currentQuery = query.trim();
        if (!currentQuery) {
            close();
            return;
        }

        if (searchInFlight.value) {
            pendingQuery.value = currentQuery;
            return;
        }

        searchInFlight.value = true;
        try {
            while (currentQuery) {
                await executeSearch(currentQuery);

                const pending = pendingQuery.value?.trim() ?? '';
                pendingQuery.value = null;
                if (!pending || pending === currentQuery) break;
                currentQuery = pending;
            }
        } finally {
            searchInFlight.value = false;
            flushPendingLoads();
        }
    }

    /**
     * 以防抖方式调度搜索。
     *
     * @param query 查询文本。
     * @returns void
     */
    function scheduleSearch(query: string) {
        clearDebounceTimer();
        debounceTimer = setTimeout(() => {
            void runSearchLoop(query);
        }, DEBOUNCE_MS);
    }

    /**
     * 打开面板并立即执行当前查询。
     *
     * @returns void
     */
    function open() {
        if (!enabled.value) return;

        const query = searchQuery.value.trim();
        if (!query) {
            close();
            return;
        }

        void refreshStatus();
        void runSearchLoop(query);
    }

    /**
     * 关闭面板并清空结果状态。
     *
     * @returns void
     */
    function close() {
        clearDebounceTimer();
        lastSearchedQuery = '';
        requestId.value += 1;
        pendingQuery.value = null;
        pruneIconMaps(true);
        resetLoadingState();
        emitOpenUpdate(false);
        resetResultState();
    }

    /**
     * 从外部触发搜索（页面层调用）。
     *
     * @param query 查询文本。
     * @returns void
     */
    function triggerSearch(query: string) {
        if (!enabled.value) return;

        if (!query.trim()) {
            close();
            return;
        }

        emitOpenUpdate(true);
        scheduleSearch(query);
    }

    // 4. 右键菜单
    const isContextMenuOpen = ref(false);

    const { open: openContextMenu, close: closeContextMenu } = useContextMenu<QuickShortcutItem>(
        CONTEXT_MENU_ITEMS,
        async (key, item) => {
            isContextMenuOpen.value = false;
            await handleContextMenuAction(key, item);
        }
    );

    async function handleContextMenuAction(key: string, item: QuickShortcutItem) {
        if (key === 'open-folder') {
            try {
                await revealItemInDir(item.path);
            } catch (error) {
                console.error('[QuickSearchPanel] Failed to reveal in folder:', error);
            }
        } else if (key === 'copy-path') {
            try {
                await clipboardService.writeText(item.path);
            } catch (error) {
                console.error('[QuickSearchPanel] Failed to copy path:', error);
            }
        }
    }

    function handleContextMenu(event: MouseEvent, index: number) {
        const item = results.value[index];
        if (!item) return;
        highlightedIndex.value = index;
        isContextMenuOpen.value = true;
        openContextMenu(event, item);
    }

    function openContextMenuForItem(index: number) {
        const item = results.value[index];
        if (!item) return;
        highlightedIndex.value = index;
        const el = itemRefs.value[index];
        if (el) {
            const rect = el.getBoundingClientRect();
            const syntheticEvent = new MouseEvent('contextmenu', {
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2,
                bubbles: true,
            });
            isContextMenuOpen.value = true;
            openContextMenu(syntheticEvent, item);
        }
    }

    function openContextMenuForHighlightedItem() {
        if (highlightedIndex.value >= 0) {
            openContextMenuForItem(highlightedIndex.value);
        }
    }

    function closeContextMenuAndReset() {
        isContextMenuOpen.value = false;
        closeContextMenu();
    }

    // Item interactions
    function getHighlightedItem(): QuickShortcutItem | null {
        if (highlightedIndex.value < 0) return null;
        return results.value[highlightedIndex.value] ?? null;
    }

    async function openHighlightedItem() {
        const item = getHighlightedItem();
        if (!item) return;

        clickStats.recordClick(searchQuery.value, item.path);

        try {
            await deps.openPath(item.path);
        } catch (error) {
            console.error('[QuickSearchPanel] Failed to open path:', error);
        }
    }

    /**
     * 处理结果项点击并打开对应路径。
     *
     * @param index 点击项索引。
     * @returns Promise<void>
     */
    async function handleItemClick(index: number) {
        const item = results.value[index];
        if (!item) return;

        highlightedIndex.value = index;
        clickStats.recordClick(searchQuery.value, item.path);

        try {
            await deps.openPath(item.path);
        } catch (error) {
            console.error('[QuickSearchPanel] Failed to open path:', error);
        }
    }

    return {
        prepareIndex,
        open,
        close,
        getHighlightedItem,
        openHighlightedItem,
        triggerSearch,
        goToPage,
        getNameSegments,
        scheduleSearch,
        handleContextMenu,
        openContextMenuForItem,
        openContextMenuForHighlightedItem,
        handleItemClick,
        isContextMenuOpen,
        closeContextMenuAndReset,
        cleanup: () => {
            clearDebounceTimer();
            pruneIconMaps(true);
        },
    };
}

// --- 状态 composable ---

function useQuickSearchState(options: UseQuickSearchLogicOptions) {
    const { open, emitOpenUpdate } = options;

    const results = ref<QuickShortcutItem[]>([]);
    const highlightedIndex = ref(-1);
    const itemRefs = ref<HTMLElement[]>([]);
    const scrollRef = ref<HTMLElement | null>(null);
    const requestId = ref(0);
    const searchInFlight = ref(false);
    const pendingQuery = ref<string | null>(null);
    const currentPage = ref(0);
    const totalFiles = ref(0);
    const totalResults = ref(0);
    const nextOffset = ref(0);

    const layout = useLayout({
        isOpen: open,
        results,
        highlightedIndex,
        scrollRef,
    });

    const assets = useAssetLoader({
        isOpen: open,
        results,
        requestId,
        searchInFlight,
        pendingQuery,
        gridColumns: layout.gridColumns,
        gridGap: layout.gridGap,
        selectionMaxHeight: layout.selectionMaxHeight,
        scrollRef,
        viewMode: layout.viewMode,
    });

    /**
     * 重置当前结果与布局状态。
     *
     * @returns void
     */
    function resetResultState() {
        results.value = [];
        highlightedIndex.value = -1;
        itemRefs.value = [];
        currentPage.value = 0;
        totalFiles.value = 0;
        totalResults.value = 0;
        nextOffset.value = 0;
        layout.resetLayoutState();
    }

    return {
        state: {
            emitOpenUpdate,
            isOpen: open,
            results,
            highlightedIndex,
            itemRefs,
            requestId,
            searchInFlight,
            pendingQuery,
            currentPage,
            totalFiles,
            totalResults,
            nextOffset,
            resetResultState,
            setVisibleRows: layout.setVisibleRows,
            syncLayout: layout.syncLayout,
            scheduleIconLoad: assets.scheduleIconLoad,
            scheduleImageLoad: assets.scheduleImageLoad,
            flushPendingLoads: assets.flushPendingLoads,
            resetLoadingState: assets.resetLoadingState,
            pruneIconMaps: assets.pruneIconMaps,
        },
        deps: {
            scrollRef,
            layout,
            assets,
        },
    };
}

// --- 主 composable ---

export function useQuickSearchLogic(
    options: UseQuickSearchLogicOptions,
    deps: UseQuickSearchDeps = DEFAULT_DEPS
) {
    const { open, searchQuery, enabled, emitOpenUpdate } = options;

    const {
        state: {
            results,
            highlightedIndex,
            itemRefs,
            requestId,
            searchInFlight,
            pendingQuery,
            currentPage,
            totalFiles,
            totalResults,
            nextOffset,
            resetResultState,
            setVisibleRows,
            syncLayout,
            scheduleIconLoad,
            scheduleImageLoad,
            flushPendingLoads,
            resetLoadingState,
            pruneIconMaps,
        },
        deps: { scrollRef, layout, assets },
    } = useQuickSearchState(options);

    const isLoadingMore = ref(false);

    const quickSearch = useQuickSearchFlow(
        {
            searchQuery,
            enabled,
            emitOpenUpdate,
            isOpen: open,
            results,
            highlightedIndex,
            itemRefs,
            requestId,
            searchInFlight,
            pendingQuery,
            currentPage,
            totalFiles,
            totalResults,
            nextOffset,
            resetResultState,
            setVisibleRows,
            syncLayout,
            scheduleIconLoad,
            scheduleImageLoad,
            flushPendingLoads,
            resetLoadingState,
            pruneIconMaps,
        },
        deps
    );

    // 5. 无限滚动懒加载
    /**
     * 加载下一页文件结果并追加到当前列表。
     * 由滚动事件触发，使用 nextOffset 避免前端计算偏移错位。
     */
    async function loadMore() {
        if (isLoadingMore.value) return;
        if (results.value.length >= totalResults.value) return;

        isLoadingMore.value = true;
        const query = searchQuery.value.trim();
        const offset = nextOffset.value;
        try {
            const searchResult = await deps.quickSearch.searchShortcuts(query, PAGE_SIZE, offset);
            if (searchResult.files.length === 0) return;
            const savedScrollTop = scrollRef.value?.scrollTop ?? 0;
            results.value.push(...searchResult.files);
            totalFiles.value = searchResult.total_files;
            totalResults.value = searchResult.total_results;
            nextOffset.value = searchResult.next_offset;
            currentPage.value++;
            await nextTick();
            requestAnimationFrame(() => {
                if (scrollRef.value) {
                    scrollRef.value.scrollTop = savedScrollTop;
                }
            });
            assets.scheduleIconLoad(requestId.value, false);
            assets.scheduleImageLoad(requestId.value, false);
        } catch (error) {
            console.error('[QuickSearchPanel] Failed to load more:', error);
        } finally {
            isLoadingMore.value = false;
        }
    }

    function handleScrollWithLoadMore() {
        assets.handleScroll();
        const el = scrollRef.value;
        if (!el || isLoadingMore.value) return;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
            void loadMore();
        }
    }

    // Keyboard navigation
    function moveSelection(direction: 'up' | 'down' | 'left' | 'right') {
        layout.moveSelection(direction);
    }

    // 6. 生命周期与状态同步
    watch(open, (isOpen) => {
        if (isOpen) {
            if (results.value.length > 0) {
                layout.updateLayout();
                if (highlightedIndex.value >= 0) {
                    layout.scrollHighlightedIntoView();
                }
            } else {
                void syncLayout();
            }
            assets.scheduleIconLoad(requestId.value, false);
            assets.scheduleImageLoad(requestId.value, false);
        } else {
            if (results.value.length === 0) {
                highlightedIndex.value = -1;
                void nextTick(() => {
                    if (scrollRef.value) {
                        scrollRef.value.scrollTop = 0;
                    }
                });
            }
        }
    });

    watch(
        [searchQuery, enabled],
        ([query, isEnabled]) => {
            if (!isEnabled || !open.value) return;
            quickSearch.scheduleSearch(query);
        },
        { flush: 'post' }
    );

    onMounted(() => {
        void quickSearch.prepareIndex(false);
        window.addEventListener('resize', handleViewportResize);
    });

    onUnmounted(() => {
        quickSearch.cleanup();
        window.removeEventListener('resize', handleViewportResize);
    });

    watch(enabled, (val) => {
        if (!val && open.value) {
            requestCloseFromPanel();
        }
    });

    /**
     * 处理视口变化并同步布局。
     *
     * @returns void
     */
    function handleViewportResize() {
        if (!open.value || results.value.length === 0) return;
        layout.updateLayout();
    }

    function requestCloseFromPanel() {
        quickSearch.close();
    }

    /**
     * 收缩面板到默认折叠态，清除高亮并重置滚动位置。
     * 用于 Escape 键触发的"回到初始状态"操作。
     */
    function collapseToDefault() {
        highlightedIndex.value = -1;
        layout.setVisibleRows(COLLAPSED_VISIBLE_ROWS);
        layout.updateLayout();
        void nextTick(() => {
            if (scrollRef.value) {
                scrollRef.value.scrollTop = 0;
            }
        });
    }

    // Return
    return {
        results,
        highlightedIndex,
        itemRefs,
        scrollRef,
        scrollStyle: layout.scrollStyle,
        gridStyle: layout.gridStyle,
        moveSelection,
        iconMap: assets.iconMap,
        imagePreviewMap: assets.imagePreviewMap,
        isImageItem: assets.isImageItem,
        getItemHoverTitle: assets.getItemHoverTitle,
        handleScroll: handleScrollWithLoadMore,
        isContextMenuOpen: quickSearch.isContextMenuOpen,
        closeContextMenu: quickSearch.closeContextMenuAndReset,
        getNameSegments: quickSearch.getNameSegments,
        handleItemClick: quickSearch.handleItemClick,
        handleContextMenu: quickSearch.handleContextMenu,
        openContextMenuForItem: quickSearch.openContextMenuForItem,
        openContextMenuForHighlightedItem: quickSearch.openContextMenuForHighlightedItem,
        open: quickSearch.open,
        close: requestCloseFromPanel,
        syncClosedState: () => {},
        getHighlightedItem: quickSearch.getHighlightedItem,
        openHighlightedItem: quickSearch.openHighlightedItem,
        triggerSearch: quickSearch.triggerSearch,
        goToPage: quickSearch.goToPage,
        goToNextPage: () => quickSearch.goToPage(),
        goToPreviousPage: () => quickSearch.goToPage(),
        currentPage,
        totalFiles,
        totalResults,
        isLoadingMore,
        viewMode: layout.viewMode,
        toggleViewMode: layout.toggleViewMode,
        collapseToDefault,
    };
}
