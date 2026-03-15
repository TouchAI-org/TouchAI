import { native, type QuickShortcutItem } from '@services/NativeService';
import { getPathExtension, IMAGE_EXTENSIONS } from '@utils/path';
import { type Ref, ref } from 'vue';

import { ITEM_SIZE_PX } from './useLayout';

const LIMIT = 60; // 缓存裁剪阈值基数（触发条件约为 LIMIT * 6）
const ICON_LOAD_DELAY_MS = 220; // 图标批次调度延时（非立即模式）
const ICON_SCROLL_THROTTLE_MS = 40; // 滚动后重新排队加载的节流窗口
const ICON_BATCH_SIZE = 4; // 单批图标请求数量
const ICON_MAX_ATTEMPTS = 2; // 单个图标的最大重试次数
const IMAGE_LOAD_DELAY_MS = 120; // 图片批次调度延时（非立即模式）
const IMAGE_BATCH_SIZE = 2; // 单批图片预览请求数量
const IMAGE_MAX_ATTEMPTS = 2; // 单张图片预览的最大重试次数
const IMAGE_THUMB_SIZE = 56; // 图片缩略图尺寸（px）
const ICON_PRELOAD_MIN_COUNT = 8; // 队列不足时顶部预热的最小目标数
const ICON_VIEWPORT_BUFFER_ROWS = 1; // 视口上下额外预加载行数
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
     * 判断条目来源是否为快捷入口而非普通文件。
     *
     * @param source 条目来源类型。
     * @returns source 非 file 时返回 true。
     */
    function isShortcutSource(source: QuickShortcutItem['source']): boolean {
        return source !== 'file';
    }

    /**
     * 判断条目是否需要通过 Rust 图标接口加载图标。
     *
     * @param item 待判断条目。
     * @returns 需要加载图标时返回 true。
     */
    function shouldLoadRustIcon(item: QuickShortcutItem): boolean {
        return !isImageItem(item);
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
     *
     * @param item 待判断条目。
     * @returns 条目是本地图片文件时返回 true。
     */
    // 统一图片项判断，模板与加载队列共享同一规则。
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
     * 收集图片加载队列，优先视口附近项目。
     *
     * @param items 当前结果列表。
     * @param options 队列构建选项。
     * @returns 图片预览加载路径队列。
     */
    // 先加载视口附近项目，再补充顶部高优先级项目，提升首屏命中率。
    function collectImageQueue(
        items: QuickShortcutItem[],
        options: { includeTopPriority?: boolean } = {}
    ): string[] {
        if (items.length === 0) return [];
        const includeTopPriority = options.includeTopPriority ?? true;

        // 1. 根据当前滚动位置估算“视口 + 缓冲区”行范围。
        const columns = Math.max(gridColumns.value, 1);
        const gap = Math.max(gridGap.value, 0);
        const rowHeight = Math.max(ITEM_SIZE_PX + gap, 1);
        const scrollTop = scrollRef.value?.scrollTop ?? 0;
        const viewportHeight = scrollRef.value?.clientHeight ?? selectionMaxHeight.value;

        const firstVisibleRow = Math.max(
            Math.floor(scrollTop / rowHeight) - ICON_VIEWPORT_BUFFER_ROWS,
            0
        );
        const lastVisibleRow =
            Math.ceil((scrollTop + viewportHeight) / rowHeight) + ICON_VIEWPORT_BUFFER_ROWS;

        const startIndex = Math.min(items.length, firstVisibleRow * columns);
        const endIndex = Math.min(items.length, (lastVisibleRow + 1) * columns);

        // 2. 构建带去重与状态过滤的入队函数。
        const queue: string[] = [];
        const seen = new Set<string>();
        const pushPath = (path: string) => {
            if (seen.has(path)) return;
            if (imagePreviewMap.value[path] || imageLoadingPaths.has(path)) return;
            if ((imageAttempts.get(path) ?? 0) >= IMAGE_MAX_ATTEMPTS) return;
            seen.add(path);
            queue.push(path);
        };

        // 3. 将当前可视区域图片项筛选出来。
        const visibleItems = items.slice(startIndex, endIndex);
        for (const item of visibleItems) {
            if (isImageItem(item)) {
                pushPath(item.path);
            }
        }

        // 4. 可视区不足时，再补齐顶部高优先级项用于首屏预热。
        if (includeTopPriority && queue.length < ICON_PRELOAD_MIN_COUNT) {
            const topPriorityItems = items.slice(0, ICON_PRELOAD_MIN_COUNT * 2);
            for (const item of topPriorityItems) {
                if (isImageItem(item)) {
                    pushPath(item.path);
                }
            }
        }

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

        // 1. 根据滚动位置估算当前应优先加载的网格区间。
        const columns = Math.max(gridColumns.value, 1);
        const gap = Math.max(gridGap.value, 0);
        const rowHeight = Math.max(ITEM_SIZE_PX + gap, 1);
        const scrollTop = scrollRef.value?.scrollTop ?? 0;
        const viewportHeight = scrollRef.value?.clientHeight ?? selectionMaxHeight.value;

        const firstVisibleRow = Math.max(
            Math.floor(scrollTop / rowHeight) - ICON_VIEWPORT_BUFFER_ROWS,
            0
        );
        const lastVisibleRow =
            Math.ceil((scrollTop + viewportHeight) / rowHeight) + ICON_VIEWPORT_BUFFER_ROWS;

        const startIndex = Math.min(items.length, firstVisibleRow * columns);
        const endIndex = Math.min(items.length, (lastVisibleRow + 1) * columns);

        // 2. 构建带去重、已加载过滤、重试上限过滤的入队函数。
        const queue: string[] = [];
        const seen = new Set<string>();
        const pushPath = (path: string) => {
            if (seen.has(path)) return;
            if (iconMap.value[path] || iconLoadingPaths.has(path)) return;
            if ((iconAttempts.get(path) ?? 0) >= ICON_MAX_ATTEMPTS) return;
            seen.add(path);
            queue.push(path);
        };

        // 3. 先可视区内加载：shortcut 优先，file 次之。
        const visibleItems = items.slice(startIndex, endIndex);
        // 优先 shortcut 再 file，可提升应用入口图标的体感命中率。
        const visibleShortcutItems = visibleItems.filter((item) => isShortcutSource(item.source));
        const visibleFileItems = visibleItems.filter((item) => !isShortcutSource(item.source));
        for (const item of visibleShortcutItems) {
            if (shouldLoadRustIcon(item)) {
                pushPath(item.path);
            }
        }
        for (const item of visibleFileItems) {
            if (shouldLoadRustIcon(item)) {
                pushPath(item.path);
            }
        }

        // 4. 可视区不足时，再补齐顶部高优先级项。
        if (includeTopPriority && queue.length < ICON_PRELOAD_MIN_COUNT) {
            const topPriorityItems = items.slice(0, ICON_PRELOAD_MIN_COUNT * 2);
            const topShortcuts = topPriorityItems.filter((item) => isShortcutSource(item.source));
            const topFiles = topPriorityItems.filter((item) => !isShortcutSource(item.source));
            for (const item of topShortcuts) {
                if (shouldLoadRustIcon(item)) {
                    pushPath(item.path);
                }
            }
            for (const item of topFiles) {
                if (shouldLoadRustIcon(item)) {
                    pushPath(item.path);
                }
            }
        }

        return queue;
    }

    // 4. 批次加载执行
    /**
     * 执行一批图片预览加载，并在完成后调度下一批。
     *
     * @param reqId 当前请求编号。
     * @returns Promise<void>
     */
    async function loadImageBatch(reqId: number) {
        if (reqId !== requestId.value || !isOpen.value) return;

        // 1. 生成本批次任务，空队列直接返回。
        const queue = collectImageQueue(results.value);
        if (queue.length === 0) return;

        const batchPaths = queue.slice(0, IMAGE_BATCH_SIZE);
        // 2. 请求前先标记“加载中”和重试计数，避免重复入队。
        batchPaths.forEach((path) => {
            imageLoadingPaths.add(path);
            const current = imageAttempts.get(path) ?? 0;
            imageAttempts.set(path, current + 1);
        });
        imageLoadInFlight = true;

        try {
            const previewResult = await deps.getImageThumbnails(batchPaths, IMAGE_THUMB_SIZE);
            // 3. 仅在请求仍然有效时合并结果，防止旧查询覆盖新状态。
            if (reqId !== requestId.value || !isOpen.value) return;

            if (Object.keys(previewResult).length > 0) {
                Object.assign(imagePreviewMap.value, previewResult);
            }
        } catch (error) {
            console.warn('[QuickSearchPanel] Failed to load image thumbnails:', error);
        } finally {
            // 4. 回收本批次状态，并按 pending/remaining 继续调度。
            batchPaths.forEach((path) => imageLoadingPaths.delete(path));
            imageLoadInFlight = false;

            if (imageLoadPending) {
                imageLoadPending = false;
                scheduleImageLoad(reqId, true);
            } else if (reqId === requestId.value && isOpen.value) {
                const remaining = collectImageQueue(results.value, {
                    includeTopPriority: false,
                });
                if (remaining.length > 0) {
                    scheduleImageLoad(reqId, true);
                }
            }
        }
    }

    /**
     * 执行一批图标加载，并在完成后调度下一批。
     *
     * @param reqId 当前请求编号。
     * @returns Promise<void>
     */
    async function loadIconBatch(reqId: number) {
        if (reqId !== requestId.value || !isOpen.value) return;

        // 1. 生成本批次任务，空队列直接返回。
        const queue = collectIconQueue(results.value);
        if (queue.length === 0) return;

        const batchPaths = queue.slice(0, ICON_BATCH_SIZE);
        // 2. 请求前先标记“加载中”和重试计数，避免重复入队。
        batchPaths.forEach((path) => {
            iconLoadingPaths.add(path);
            const current = iconAttempts.get(path) ?? 0;
            iconAttempts.set(path, current + 1);
        });
        iconLoadInFlight = true;

        try {
            const iconResult = await deps.getShortcutIcons(batchPaths, ICON_SIZE);
            // 3. 仅在请求仍然有效时合并结果，防止旧查询覆盖新状态。
            if (reqId !== requestId.value || !isOpen.value) return;

            if (Object.keys(iconResult).length > 0) {
                Object.assign(iconMap.value, iconResult);
            }
        } catch (error) {
            console.warn('[QuickSearchPanel] Failed to load shortcut icons:', error);
        } finally {
            // 4. 回收本批次状态，并按 pending/remaining 继续调度。
            batchPaths.forEach((path) => iconLoadingPaths.delete(path));
            iconLoadInFlight = false;

            if (iconLoadPending) {
                iconLoadPending = false;
                scheduleIconLoad(reqId, true);
            } else if (reqId === requestId.value && isOpen.value) {
                const remaining = collectIconQueue(results.value, {
                    includeTopPriority: false,
                });
                if (remaining.length > 0) {
                    scheduleIconLoad(reqId, true);
                }
            }
        }
    }

    // 5. 调度与滚动联动
    /**
     * 调度图片加载；搜索进行中或批次未完成时仅标记 pending。
     *
     * @param reqId 请求编号，默认当前请求。
     * @param immediate 是否立即触发加载。
     * @returns void
     */
    function scheduleImageLoad(reqId = requestId.value, immediate = false) {
        if (!isOpen.value || reqId !== requestId.value) return;

        // 搜索或批次加载未完成时仅标记 pending，避免并发批次。
        if (searchInFlight.value || pendingQuery.value) {
            imageLoadPending = true;
            return;
        }
        if (imageLoadInFlight) {
            imageLoadPending = true;
            return;
        }

        clearImageLoadTimer();
        const delay = immediate ? 0 : IMAGE_LOAD_DELAY_MS;
        imageLoadTimer = setTimeout(() => {
            void loadImageBatch(requestId.value);
        }, delay);
    }

    /**
     * 调度图标加载；搜索进行中或批次未完成时仅标记 pending。
     *
     * @param reqId 请求编号，默认当前请求。
     * @param immediate 是否立即触发加载。
     * @returns void
     */
    function scheduleIconLoad(reqId = requestId.value, immediate = false) {
        if (!isOpen.value || reqId !== requestId.value) return;

        // 搜索或批次加载未完成时仅标记 pending，避免并发批次。
        if (searchInFlight.value || pendingQuery.value) {
            iconLoadPending = true;
            return;
        }
        if (iconLoadInFlight) {
            iconLoadPending = true;
            return;
        }

        clearIconLoadTimer();
        const delay = immediate ? 0 : ICON_LOAD_DELAY_MS;
        iconLoadTimer = setTimeout(() => {
            void loadIconBatch(requestId.value);
        }, delay);
    }

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
        }, ICON_SCROLL_THROTTLE_MS);
        imageLoadTimer = setTimeout(() => {
            scheduleImageLoad(requestId.value, true);
        }, ICON_SCROLL_THROTTLE_MS);
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
