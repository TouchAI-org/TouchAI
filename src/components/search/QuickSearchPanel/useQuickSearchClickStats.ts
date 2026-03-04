import {
    findQuickSearchClicksByQuery,
    upsertQuickSearchClick,
} from '@database/queries/quickSearchClicks';
import type { QuickShortcutItem } from '@services/NativeService';

const MAX_CLICK_COUNT = 1_000_000; // 单条路径点击上限，防止计数无限增长
const MAX_CLICK_PATH_ENTRIES = 200; // 单个 query 最多加载的路径统计条目数

type ClickStatsMap = Record<string, Record<string, number>>;

/**
 * 规范化点击统计 query。
 * 统一大小写与空白，保证同义输入命中同一统计键。
 *
 * @param query 原始查询文本。
 * @returns 规范化后的 query；无有效 token 时返回 null。
 */
function normalizeClickQuery(query: string): string | null {
    const tokens = query
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
    return tokens.length > 0 ? tokens.join(' ') : null;
}

/**
 * 规范化路径键。
 * 统一分隔符与大小写，降低同一路径不同写法造成的统计分裂。
 *
 * @param path 原始路径。
 * @returns 规范化路径。
 */
function normalizeClickPath(path: string): string {
    return path.trim().replace(/\//g, '\\').toLowerCase();
}

/**
 * 更新内存缓存中的点击计数。
 *
 * @param clickStats 按 query/path 组织的点击缓存。
 * @param query 原始查询文本。
 * @param path 原始路径。
 * @returns void
 */
function updateClickStatsCache(clickStats: ClickStatsMap, query: string, path: string) {
    const queryNorm = normalizeClickQuery(query);
    const pathNorm = normalizeClickPath(path);
    if (!queryNorm || !pathNorm) {
        return;
    }

    const pathStats = (clickStats[queryNorm] ??= {});
    const current = pathStats[pathNorm] ?? 0;
    pathStats[pathNorm] = Math.min(MAX_CLICK_COUNT, current + 1);
}

/**
 * 快速搜索点击统计能力。
 * 负责按点击次数重排结果，并在点击后写入 SQLite（通过 query 封装层）。
 *
 * @returns 点击统计相关方法集合。
 */
export function useQuickSearchClickStats() {
    // 本地缓存：按规范化 query 缓存 path->count，避免每次搜索都读库。
    const clickStats: ClickStatsMap = {};

    /**
     * 按点击统计对搜索结果做稳定重排。
     *
     * @param query 当前查询文本。
     * @param items 原始搜索结果。
     * @returns 重排后的搜索结果。
     */
    async function rankResults(
        query: string,
        items: QuickShortcutItem[]
    ): Promise<QuickShortcutItem[]> {
        const queryNorm = normalizeClickQuery(query);
        if (!queryNorm) {
            return items;
        }

        // 懒加载：首次命中某 query 时再读取 SQLite，并回填到内存缓存。
        if (!clickStats[queryNorm]) {
            try {
                const rows = await findQuickSearchClicksByQuery({
                    queryNorm,
                    limit: MAX_CLICK_PATH_ENTRIES,
                });

                const pathStats: Record<string, number> = {};
                for (const row of rows) {
                    const pathNorm = normalizeClickPath(row.path_norm);
                    const count = Number(row.click_count ?? 0);
                    if (!pathNorm || !Number.isFinite(count) || count <= 0) {
                        continue;
                    }
                    pathStats[pathNorm] = Math.min(MAX_CLICK_COUNT, Math.floor(count));
                }
                clickStats[queryNorm] = pathStats;
            } catch (error) {
                console.warn('[QuickSearchPanel] Failed to load click stats from sqlite:', error);
                clickStats[queryNorm] = {};
            }
        }

        const pathStats = clickStats[queryNorm];
        let hasClickBoost = false;
        // 记录原始索引，后续同分时按原顺序回退，保持稳定排序。
        const ranked = items.map((item, index) => {
            const clickCount = pathStats[normalizeClickPath(item.path)] ?? 0;
            if (clickCount > 0) {
                hasClickBoost = true;
            }
            return { item, index, clickCount };
        });

        if (!hasClickBoost) {
            return items;
        }

        ranked.sort((left, right) => {
            if (right.clickCount !== left.clickCount) {
                return right.clickCount - left.clickCount;
            }
            return left.index - right.index;
        });

        return ranked.map((entry) => entry.item);
    }

    /**
     * 记录一次点击行为。
     * 先更新内存缓存，再异步持久化到 SQLite。
     *
     * @param query 当前查询文本。
     * @param path 被点击项路径。
     * @returns void
     */
    function recordClick(query: string, path: string) {
        updateClickStatsCache(clickStats, query, path);

        const queryNorm = normalizeClickQuery(query);
        const pathNorm = normalizeClickPath(path);
        if (!queryNorm || !pathNorm) {
            return;
        }

        // 写库走查询层封装；失败仅记录日志，不阻塞主流程。
        void upsertQuickSearchClick({
            queryNorm,
            pathNorm,
            maxClickCount: MAX_CLICK_COUNT,
        }).catch((error) =>
            console.warn('[QuickSearchPanel] Failed to record click to sqlite:', error)
        );
    }

    return {
        rankResults,
        recordClick,
    };
}
