import { native, type QuickShortcutItem } from '@services/NativeService';
import { getPathExtension, IMAGE_EXTENSIONS } from '@utils/path';
import { type Ref, ref } from 'vue';

import { ITEM_SIZE_PX, LIST_ROW_HEIGHT_PX, type ViewMode } from './useLayout';

const LIMIT = 60; // 缓存裁剪阈值基数（触发条件约为 LIMIT * 6）
const ICON_LOAD_DELAY_MS = 220; // 图标批次调度延时（非立即模式）
const SCROLL_THROTTLE_MS = 40; // 滚动后重新排队加载的节流窗口
const ICON_BATCH_SIZE = 4; // 单批图标请求数量
const ICON_MAX_ATTEMPTS = 2; // 单个图标的最大重试次数
const IMAGE_LOAD_DELAY_MS = 120; // 图片批次调度延时（非立即模式）
const IMAGE_BATCH_SIZE = 2; // 单批图片预览请求数量
const IMAGE_MAX_ATTEMPTS = 2; // 单张图片预览的最大重试次数
const IMAGE_THUMB_SIZE = 56; // 图片缩略图尺寸（px）
const PRELOAD_MIN_COUNT = 8; // 队列不足时顶部预热的最小目标数
const VIEWPORT_BUFFER_ROWS = 1; // 视口上下额外预加载行数
const ICON_SIZE = 48; // 图标请求尺寸（px）

interface UseAssetLoaderOptions {
    isOpen: Ref<boolean>;
    results: Ref<QuickShortcutItem[]>;
    requestId: Ref<number>;
    searchInFlight: Ref<boolean>;
    pendingQuery: Ref<string | null>;
    gridColumns: Ref<number>;
    gridGap: Ref<number>;
    selectionMaxHeight: Ref<number>;
    scrollRef: Ref<HTMLElement | null>;
    viewMode: Ref<ViewMode>;
}

export interface UseAssetLoaderDeps {
    getImageThumbnails: (paths: string[], thumbSize: number) => Promise<Record<string, string>>;
    getShortcutIcons: (paths: string[], iconSize: number) => Promise<Record<string, string>>;
}

const DEFAULT_DEPS: UseAssetLoaderDeps = {
    getImageThumbnails: (paths, thumbSize) =>
        native.quickSearch.getImageThumbnails(paths, thumbSize),
    getShortcutIcons: (paths, iconSize) => native.quickSearch.getShortcutIcons(paths, iconSize),
};

/**
 * 快捷面板资源加载器。
 * 负责图标/缩略图队列构建、批次加载、滚动联动调度与缓存回收。
 *
 * @param options 资源加载依赖项与当前布局/滚动状态引用。
 * @param deps 可注入资源请求依赖，默认使用 native.quickSearch。
 * @returns 图标与缩略图状态、加载调度方法和状态重置方法。
 */
export function useAssetLoader(
    options: UseAssetLoaderOptions,
    deps: UseAssetLoaderDeps = DEFAULT_DEPS
) {
    const {
        isOpen,
        results,
        requestId,
        searchInFlight,
        pendingQuery,
        gridColumns,
        gridGap,
        selectionMaxHeight,
        scrollRef,
        viewMode,
    } = options;

    // 1. 资源缓存与加载状态
    const iconMap = ref<Record<string, string>>({});
    const imagePreviewMap = ref<Record<string, string>>({});

    // 高频状态不使用响应式，避免滚动/加载期间触发不必要渲染。
    const iconLoadingPaths = new Set<string>();
    const iconAttempts = new Map<string, number>();
    const imageLoadingPaths = new Set<string>();
    const imageAttempts = new Map<string, number>();
    let iconLoadTimer: ReturnType<typeof setTimeout> | null = null;
    let imageLoadTimer: ReturnType<typeof setTimeout> | null = null;
    let iconLoadInFlight = false;
    let iconLoadPending = false;
    let imageLoadInFlight = false;
    let imageLoadPending = false;

    // 2. 基础工具方法
    /**
     * 清除图标加载计时器。
     *
     * @returns void
     */
    function clearIconLoadTimer() {
        if (iconLoadTimer) {
            clearTimeout(iconLoadTimer);
            iconLoadTimer = null;
        }
    }

    /**
     * 清除图片加载计时器。
     *
     * @returns void
     */
    function clearImageLoadTimer() {
        if (imageLoadTimer) {
            clearTimeout(imageLoadTimer);
            imageLoadTimer = null;
        }
    }

    /**
     * 按扩展名判断路径是否为图片文件。
     *
     * @param path 文件路径。
     * @returns 扩展名属于图片类型时返回 true。
     */
    function isImageFilePath(path: string): boolean {
        return IMAGE_EXTENSIONS.has(getPathExtension(path));
    }

    /**
     * 判断条目是否为可加载预览图的图片项。
     * 统一图片项判断，模板与加载队列共享同一规则。
     *
     * @param item 待判断条目。
     * @returns 条目是本地图片文件时返回 true。
     */
    function isImageItem(item: QuickShortcutItem): boolean {
        return item.source === 'file' && isImageFilePath(item.path);
    }

    /**
     * 生成条目 hover 提示文本。
     *
     * @param item 当前条目。
     * @returns 可展示路径提示文本；非路径来源返回空字符串。
     */
    function getItemHoverTitle(item: QuickShortcutItem): string {
        return item.source === 'file' || item.source === 'shortcut_file' ? item.path : '';
    }

    /**
     * 裁剪图标与预览缓存，避免缓存无限增长。
     *
     * @param force 是否强制裁剪缓存。
     * @returns void
     */
    function pruneIconMaps(force = false) {
        const iconCount = Object.keys(iconMap.value).length;
        const previewCount = Object.keys(imagePreviewMap.value).length;
        if (!force && iconCount + previewCount < LIMIT * 6) {
            return;
        }

        const keepPaths = new Set(results.value.map((item) => item.path));
        for (const path of Object.keys(iconMap.value)) {
            if (!keepPaths.has(path) && !iconLoadingPaths.has(path)) {
                delete iconMap.value[path];
            }
        }
        for (const path of Object.keys(imagePreviewMap.value)) {
            if (!keepPaths.has(path) && !imageLoadingPaths.has(path)) {
                delete imagePreviewMap.value[path];
            }
        }
    }

    // 3. 加载队列构建
    /**
     * 根据当前滚动位置计算视口内（含缓冲行）的起止索引。
     *
     * @param items 总结果列表。
     * @returns [startIndex, endIndex) 范围。
     */
    function computeViewportRange(items: QuickShortcutItem[]): [number, number] {
        const columns = Math.max(gridColumns.value, 1);
        const gap = viewMode.value === 'list' ? 0 : Math.max(gridGap.value, 0);
        const rowHeight = Math.max(
            (viewMode.value === 'list' ? LIST_ROW_HEIGHT_PX : ITEM_SIZE_PX) + gap,
            1
        );
        const scrollTop = scrollRef.value?.scrollTop ?? 0;
        const viewportHeight = scrollRef.value?.clientHeight ?? selectionMaxHeight.value;

        const firstVisibleRow = Math.max(
            Math.floor(scrollTop / rowHeight) - VIEWPORT_BUFFER_ROWS,
            0
        );
        const lastVisibleRow =
            Math.ceil((scrollTop + viewportHeight) / rowHeight) + VIEWPORT_BUFFER_ROWS;

        return [
            Math.min(items.length, firstVisibleRow * columns),
            Math.min(items.length, (lastVisibleRow + 1) * columns),
        ];
    }

    /**
     * 从视口范围内收集匹配 predicate 的条目路径；队列不足时补齐顶部高优先级项。
     *
     * @param items 当前结果列表。
     * @param predicate 条目筛选条件。
     * @param pushPath 入队函数（负责去重与状态过滤）。
     * @param queue 目标队列。
     * @param includeTopPriority 是否在视口不足时补充顶部预热项。
     */
    function collectItemsFromViewport(
        items: QuickShortcutItem[],
        predicate: (item: QuickShortcutItem) => boolean,
        pushPath: (path: string) => void,
        queue: string[],
        includeTopPriority: boolean
    ) {
        const [startIndex, endIndex] = computeViewportRange(items);
        const visibleItems = items.slice(startIndex, endIndex);

        // shortcut 优先于 file 排入队列，提升应用入口图标的体感命中率。
        const shortcutItems = visibleItems.filter(
            (item) => item.source !== 'file' && predicate(item)
        );
        const fileItems = visibleItems.filter((item) => item.source === 'file' && predicate(item));
        for (const item of shortcutItems) pushPath(item.path);
        for (const item of fileItems) pushPath(item.path);

        // 视口项不足时补齐顶部高优先级项用于首屏预热。
        if (includeTopPriority && queue.length < PRELOAD_MIN_COUNT) {
            const topItems = items.slice(0, PRELOAD_MIN_COUNT * 2);
            for (const item of topItems) {
                if (predicate(item)) pushPath(item.path);
            }
        }
    }

    /**
     * 收集图片加载队列，优先视口附近项目。
     *
     * @param items 当前结果列表。
     * @param options 队列构建选项。
     * @returns 图片预览加载路径队列。
     */
    function collectImageQueue(
        items: QuickShortcutItem[],
        options: { includeTopPriority?: boolean } = {}
    ): string[] {
        if (items.length === 0) return [];
        const includeTopPriority = options.includeTopPriority ?? true;

        const queue: string[] = [];
        const seen = new Set<string>();
        const pushPath = (path: string) => {
            if (seen.has(path)) return;
            if (imagePreviewMap.value[path] || imageLoadingPaths.has(path)) return;
            if ((imageAttempts.get(path) ?? 0) >= IMAGE_MAX_ATTEMPTS) return;
            seen.add(path);
            queue.push(path);
        };

        collectItemsFromViewport(items, isImageItem, pushPath, queue, includeTopPriority);
        return queue;
    }

    /**
     * 收集图标加载队列，优先快捷入口项目。
     *
     * @param items 当前结果列表。
     * @param options 队列构建选项。
     * @returns 图标加载路径队列。
     */
    function collectIconQueue(
        items: QuickShortcutItem[],
        options: { includeTopPriority?: boolean } = {}
    ): string[] {
        if (items.length === 0) return [];
        const includeTopPriority = options.includeTopPriority ?? true;

        const queue: string[] = [];
        const seen = new Set<string>();
        const pushPath = (path: string) => {
            if (seen.has(path)) return;
            if (iconMap.value[path] || iconLoadingPaths.has(path)) return;
            if ((iconAttempts.get(path) ?? 0) >= ICON_MAX_ATTEMPTS) return;
            seen.add(path);
            queue.push(path);
        };

        collectItemsFromViewport(
            items,
            (item) => !isImageItem(item),
            pushPath,
            queue,
            includeTopPriority
        );
        return queue;
    }

    // 4. 批次加载与调度
    /**
     * 创建通用批次加载调度器，消除图标/图片加载的重复逻辑。
     */
    function createBatchLoader(config: {
        collectQueue: (
            items: QuickShortcutItem[],
            options?: { includeTopPriority?: boolean }
        ) => string[];
        batchSize: number;
        loadingPaths: Set<string>;
        attempts: Map<string, number>;
        resultRef: typeof iconMap;
        loadInFlightRef: { value: boolean };
        loadPendingRef: { value: boolean };
        clearTimer: () => void;
        schedule: (reqId: number, immediate: boolean) => void;
        executeBatch: (paths: string[]) => Promise<Record<string, string>>;
        delayMs: number;
        errorLabel: string;
    }) {
        async function loadBatch(reqId: number) {
            if (reqId !== requestId.value || !isOpen.value) return;

            const queue = config.collectQueue(results.value);
            if (queue.length === 0) return;

            const batchPaths = queue.slice(0, config.batchSize);
            batchPaths.forEach((path) => {
                config.loadingPaths.add(path);
                const current = config.attempts.get(path) ?? 0;
                config.attempts.set(path, current + 1);
            });
            config.loadInFlightRef.value = true;

            try {
                const result = await config.executeBatch(batchPaths);
                if (reqId !== requestId.value || !isOpen.value) return;

                if (Object.keys(result).length > 0) {
                    Object.assign(config.resultRef.value, result);
                }
            } catch (error) {
                console.warn(`[QuickSearchPanel] Failed to load ${config.errorLabel}:`, error);
            } finally {
                batchPaths.forEach((path) => config.loadingPaths.delete(path));
                config.loadInFlightRef.value = false;

                if (config.loadPendingRef.value) {
                    config.loadPendingRef.value = false;
                    config.schedule(reqId, true);
                } else if (reqId === requestId.value && isOpen.value) {
                    // 仅检查视口内的剩余项，不重复计入顶部预热项。
                    const remaining = config.collectQueue(results.value, {
                        includeTopPriority: false,
                    });
                    if (remaining.length > 0) {
                        config.schedule(reqId, true);
                    }
                }
            }
        }

        function scheduleLoad(reqId = requestId.value, immediate = false) {
            if (!isOpen.value || reqId !== requestId.value) return;

            if (searchInFlight.value || pendingQuery.value) {
                config.loadPendingRef.value = true;
                return;
            }
            if (config.loadInFlightRef.value) {
                config.loadPendingRef.value = true;
                return;
            }

            config.clearTimer();
            const delay = immediate ? 0 : config.delayMs;
            setTimeout(() => {
                void loadBatch(requestId.value);
            }, delay);
        }

        return { loadBatch, scheduleLoad };
    }

    // 间接引用，让 createBatchLoader 内部的 schedule 回调能指向最终的 scheduleLoad。
    const scheduleIconLoadRef: { value: (reqId?: number, immediate?: boolean) => void } = {
        value: () => {},
    };
    const scheduleImageLoadRef: { value: (reqId?: number, immediate?: boolean) => void } = {
        value: () => {},
    };

    const iconLoader = createBatchLoader({
        collectQueue: (items) => collectIconQueue(items),
        batchSize: ICON_BATCH_SIZE,
        loadingPaths: iconLoadingPaths,
        attempts: iconAttempts,
        resultRef: iconMap,
        loadInFlightRef: {
            get value() {
                return iconLoadInFlight;
            },
            set value(v: boolean) {
                iconLoadInFlight = v;
            },
        },
        loadPendingRef: {
            get value() {
                return iconLoadPending;
            },
            set value(v: boolean) {
                iconLoadPending = v;
            },
        },
        clearTimer: clearIconLoadTimer,
        schedule: (...args) => scheduleIconLoadRef.value(...args),
        executeBatch: (paths) => deps.getShortcutIcons(paths, ICON_SIZE),
        delayMs: ICON_LOAD_DELAY_MS,
        errorLabel: 'shortcut icons',
    });
    scheduleIconLoadRef.value = iconLoader.scheduleLoad;

    const imageLoader = createBatchLoader({
        collectQueue: (items) => collectImageQueue(items),
        batchSize: IMAGE_BATCH_SIZE,
        loadingPaths: imageLoadingPaths,
        attempts: imageAttempts,
        resultRef: imagePreviewMap,
        loadInFlightRef: {
            get value() {
                return imageLoadInFlight;
            },
            set value(v: boolean) {
                imageLoadInFlight = v;
            },
        },
        loadPendingRef: {
            get value() {
                return imageLoadPending;
            },
            set value(v: boolean) {
                imageLoadPending = v;
            },
        },
        clearTimer: clearImageLoadTimer,
        schedule: (...args) => scheduleImageLoadRef.value(...args),
        executeBatch: (paths) => deps.getImageThumbnails(paths, IMAGE_THUMB_SIZE),
        delayMs: IMAGE_LOAD_DELAY_MS,
        errorLabel: 'image thumbnails',
    });
    scheduleImageLoadRef.value = imageLoader.scheduleLoad;

    const scheduleIconLoad = iconLoader.scheduleLoad;
    const scheduleImageLoad = imageLoader.scheduleLoad;

    /**
     * 处理滚动事件，节流后按新视口重新调度资源加载。
     *
     * @returns void
     */
    function handleScroll() {
        if (!isOpen.value) return;
        clearIconLoadTimer();
        clearImageLoadTimer();
        // 滚动后短暂节流，再按新视口重新排队加载。
        iconLoadTimer = setTimeout(() => {
            scheduleIconLoad(requestId.value, true);
        }, SCROLL_THROTTLE_MS);
        imageLoadTimer = setTimeout(() => {
            scheduleImageLoad(requestId.value, true);
        }, SCROLL_THROTTLE_MS);
    }

    /**
     * 刷新并执行待处理的图标/图片加载任务。
     *
     * @returns void
     */
    function flushPendingLoads() {
        if (iconLoadPending && isOpen.value) {
            iconLoadPending = false;
            scheduleIconLoad(requestId.value, false);
        }
        if (imageLoadPending && isOpen.value) {
            imageLoadPending = false;
            scheduleImageLoad(requestId.value, false);
        }
    }

    // 6. 状态收敛
    /**
     * 重置所有加载状态与尝试计数，供 close/hide/新查询复用。
     *
     * @returns void
     */
    function resetLoadingState() {
        // 统一收敛所有加载状态，供 close/hide/新查询复用。
        clearIconLoadTimer();
        clearImageLoadTimer();
        iconLoadPending = false;
        iconLoadInFlight = false;
        imageLoadPending = false;
        imageLoadInFlight = false;
        iconLoadingPaths.clear();
        iconAttempts.clear();
        imageLoadingPaths.clear();
        imageAttempts.clear();
    }

    return {
        iconMap,
        imagePreviewMap,
        isImageItem,
        getItemHoverTitle,
        clearIconLoadTimer,
        clearImageLoadTimer,
        pruneIconMaps,
        scheduleIconLoad,
        scheduleImageLoad,
        handleScroll,
        flushPendingLoads,
        resetLoadingState,
    };
}
