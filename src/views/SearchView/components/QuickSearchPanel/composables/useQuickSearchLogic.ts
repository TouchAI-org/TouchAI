import { native, type QuickShortcutItem } from '@services/NativeService';
import { openPath } from '@tauri-apps/plugin-opener';
import { computed, nextTick, onMounted, onUnmounted, type Ref, ref, watch } from 'vue';

import {
    buildMatchTokens,
    type NameSegment,
    splitNameByTokens,
} from '../utils/quickSearchHighlight';
import { useAssetLoader } from './useAssetLoader';
import { COLLAPSED_VISIBLE_ROWS, useLayout } from './useLayout';
import { useQuickSearchClickStats } from './useQuickSearchClickStats';

const LIMIT = 60; // 单次搜索最多返回结果数
const DEBOUNCE_MS = 80; // 输入防抖延时（ms）

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
        isOpen,
        results,
        highlightedIndex,
        itemRefs,
        requestId,
        searchInFlight,
        pendingQuery,
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

        // 使用单调递增请求号，丢弃延迟返回的旧查询结果。
        const reqId = ++requestId.value;

        try {
            const searchResults = await deps.quickSearch.searchShortcuts(trimmedQuery, LIMIT);
            if (reqId !== requestId.value) return;

            if (searchQuery.value.trim() !== trimmedQuery || !enabled.value) {
                return;
            }

            if (searchResults.length === 0) {
                hide();
                return;
            }

            const rankedResults = await clickStats.rankResults(trimmedQuery, searchResults);
            if (reqId !== requestId.value) return;
            if (searchQuery.value.trim() !== trimmedQuery || !enabled.value) {
                return;
            }

            emitOpenUpdate(true);
            results.value = rankedResults;
            itemRefs.value = [];
            // 新结果到达后重置资源加载状态，避免沿用上一次查询的加载队列。
            resetLoadingState();
            highlightedIndex.value = -1;
            setVisibleRows(COLLAPSED_VISIBLE_ROWS);
            await syncLayout();
            scheduleIconLoad(reqId, false);
            scheduleImageLoad(reqId, false);
        } catch (error) {
            console.error('[QuickSearchPanel] Failed to search shortcuts:', error);
            if (reqId === requestId.value) {
                hide();
            }
        }
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

        // 同一时刻只执行一个搜索；输入连发时仅保留最后一次查询。
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
                if (!pending || pending === currentQuery) {
                    break;
                }
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
        // 输入防抖，避免每个按键都触发 native 搜索。
        debounceTimer = setTimeout(() => {
            void runSearchLoop(query);
        }, DEBOUNCE_MS);
    }

    // 4. 面板生命周期与交互
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
     * 隐藏面板并重置结果展示状态。
     *
     * @returns void
     */
    function hide() {
        // 仅关闭面板，不主动清空缓存；缓存回收由 close/prune 控制。
        resetLoadingState();
        emitOpenUpdate(false);
        resetResultState();
    }

    /**
     * 关闭面板并使当前所有异步任务失效。
     *
     * @returns void
     */
    function close() {
        clearDebounceTimer();
        // 递增 requestId 可让当前所有异步任务自然失效。
        requestId.value += 1;
        pendingQuery.value = null;
        pruneIconMaps(true);
        hide();
    }

    /**
     * 获取当前高亮项。
     *
     * @returns 当前高亮项；无结果或面板关闭时返回 null。
     */
    function getHighlightedItem(): QuickShortcutItem | null {
        if (!isOpen.value || results.value.length === 0) {
            return null;
        }
        return results.value[highlightedIndex.value] ?? null;
    }

    /**
     * 打开当前高亮项，并在前端记录点击统计。
     *
     * @returns Promise<void>
     */
    async function openHighlightedItem() {
        const shortcut = getHighlightedItem();
        if (!shortcut) return;

        try {
            // 点击统计由前端写入 SQLite，并同步更新内存缓存。
            clickStats.recordClick(searchQuery.value, shortcut.path);
            await deps.window.hideSearchWindow();
            await deps.openPath(shortcut.path);
        } catch (error) {
            console.error('[QuickSearchPanel] Failed to open shortcut:', error);
        }
    }

    /**
     * 触发搜索查询，无论面板是否打开。
     * 不依赖面板 prop 中的 searchQuery（该值因 Vue 渲染批处理可能滞后），
     * 而是由调用方直接传入最新查询文本。
     * 查询到结果后面板会通过 executeSearch 自动打开。
     *
     * @param query 查询文本。
     * @returns void
     */
    function triggerSearch(query: string) {
        if (!enabled.value) return;

        const trimmed = query.trim();
        if (!trimmed) {
            close();
            return;
        }

        void refreshStatus();
        scheduleSearch(trimmed);
    }

    /**
     * 清理搜索流程的计时器与加载状态。
     *
     * @returns void
     */
    function cleanup() {
        clearDebounceTimer();
        resetLoadingState();
    }

    /**
     * 当页面层直接把 open 设为 false 时，同步回收面板内部异步状态。
     * 这是受控组件的兜底收敛路径，避免旧查询在页面已判定关闭后又把结果回填回来。
     */
    function syncClosedStateFromParent() {
        clearDebounceTimer();
        requestId.value += 1;
        pendingQuery.value = null;
        pruneIconMaps(true);
        resetLoadingState();
        resetResultState();
    }

    return {
        prepareIndex,
        open,
        close,
        syncClosedStateFromParent,
        getHighlightedItem,
        openHighlightedItem,
        triggerSearch,
        getNameSegments,
        cleanup,
    };
}

/**
 * QuickSearchPanel 顶层编排层。
 * 负责聚合布局、资源加载、搜索流程与组件生命周期。
 *
 * @param options 面板输入状态与事件回调。
 * @param deps 可注入搜索副作用依赖，默认使用 native 与 opener。
 * @returns 面板渲染状态与交互方法。
 */
export function useQuickSearchLogic(
    options: UseQuickSearchLogicOptions,
    deps: UseQuickSearchDeps = DEFAULT_DEPS
) {
    const { open, searchQuery, enabled, emitOpenUpdate } = options;

    // 1. 基础状态
    const results = ref<QuickShortcutItem[]>([]);
    const highlightedIndex = ref(-1);
    const itemRefs = ref<HTMLElement[]>([]);
    const scrollRef = ref<HTMLElement | null>(null);
    const requestId = ref(0);
    const searchInFlight = ref(false);
    const pendingQuery = ref<string | null>(null);

    // 2. 子能力组合
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
        layout.resetLayoutState();
    }

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
            resetResultState,
            setVisibleRows: layout.setVisibleRows,
            syncLayout: layout.syncLayout,
            scheduleIconLoad: assets.scheduleIconLoad,
            scheduleImageLoad: assets.scheduleImageLoad,
            flushPendingLoads: assets.flushPendingLoads,
            resetLoadingState: assets.resetLoadingState,
            pruneIconMaps: assets.pruneIconMaps,
        },
        deps
    );

    let isSyncingCloseToParent = false;

    function requestCloseFromPanel() {
        if (open.value) {
            isSyncingCloseToParent = true;
        }
        quickSearch.close();
    }

    // 3. 组件交互
    /**
     * 处理结果项点击并打开对应路径。
     *
     * @param index 点击项索引。
     * @returns Promise<void>
     */
    async function handleItemClick(index: number) {
        highlightedIndex.value = index;
        await quickSearch.openHighlightedItem();
    }

    /**
     * 处理视口变化并同步布局。
     *
     * @returns void
     */
    function handleViewportResize() {
        layout.updateLayout();
    }

    // 4. 生命周期与状态同步
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

    watch(
        [open, results],
        ([open]) => {
            if (!open) return;
            void layout.syncLayout();
            assets.scheduleIconLoad(requestId.value, false);
            assets.scheduleImageLoad(requestId.value, false);
        },
        { flush: 'post' }
    );

    watch(
        open,
        (nextOpen, previousOpen) => {
            if (nextOpen || !previousOpen) {
                return;
            }

            if (isSyncingCloseToParent) {
                isSyncingCloseToParent = false;
                return;
            }

            quickSearch.syncClosedStateFromParent();
        },
        { flush: 'sync' }
    );

    watch(
        results,
        (items) => {
            if (items.length === 0) {
                highlightedIndex.value = -1;
                return;
            }

            highlightedIndex.value = -1;
            void nextTick(() => {
                if (scrollRef.value) {
                    scrollRef.value.scrollTop = 0;
                }
            });
        },
        { flush: 'post' }
    );

    return {
        isOpen: open,
        results,
        highlightedIndex,
        itemRefs,
        scrollRef,
        scrollStyle: layout.scrollStyle,
        gridStyle: layout.gridStyle,
        moveSelection: layout.moveSelection,
        iconMap: assets.iconMap,
        imagePreviewMap: assets.imagePreviewMap,
        isImageItem: assets.isImageItem,
        getItemHoverTitle: assets.getItemHoverTitle,
        handleScroll: assets.handleScroll,
        getNameSegments: quickSearch.getNameSegments,
        handleItemClick,
        open: quickSearch.open,
        close: requestCloseFromPanel,
        syncClosedState: quickSearch.syncClosedStateFromParent,
        getHighlightedItem: quickSearch.getHighlightedItem,
        openHighlightedItem: quickSearch.openHighlightedItem,
        triggerSearch: quickSearch.triggerSearch,
    };
}
