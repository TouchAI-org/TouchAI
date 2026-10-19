import {
    findQuickSearchClicksByQuery,
    upsertQuickSearchClick,
} from '@database/queries/quickSearchClicks';
import type { QuickShortcutItem } from '@services/NativeService';
import { log } from '@services/ObservabilityService';

const MAX_CLICK_COUNT = 1_000_000; // 鍗曟潯璺緞鐐瑰嚮涓婇檺锛岄槻姝㈣鏁版棤闄愬闀?const MAX_CLICK_PATH_ENTRIES = 200; // 鍗曚釜 query 鏈€澶氬姞杞界殑璺緞缁熻鏉＄洰鏁?
type ClickStatsMap = Record<string, Record<string, number>>;

/**
 * 瑙勮寖鍖栫偣鍑荤粺璁?query銆? * 缁熶竴澶у皬鍐欎笌绌虹櫧锛屼繚璇佸悓涔夎緭鍏ュ懡涓悓涓€缁熻閿€? *
 * @param query 鍘熷鏌ヨ鏂囨湰銆? * @returns 瑙勮寖鍖栧悗鐨?query锛涙棤鏈夋晥 token 鏃惰繑鍥?null銆? */
function normalizeClickQuery(query: string): string | null {
    const tokens = query
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
    return tokens.length > 0 ? tokens.join(' ') : null;
}

/**
 * 瑙勮寖鍖栬矾寰勯敭銆? * 缁熶竴鍒嗛殧绗︿笌澶у皬鍐欙紝闄嶄綆鍚屼竴璺緞涓嶅悓鍐欐硶閫犳垚鐨勭粺璁″垎瑁傘€? *
 * @param path 鍘熷璺緞銆? * @returns 瑙勮寖鍖栬矾寰勩€? */
function normalizeClickPath(path: string): string {
    return path.trim().replace(/\//g, '\\').toLowerCase();
}

/**
 * 鏇存柊鍐呭瓨缂撳瓨涓殑鐐瑰嚮璁℃暟銆? *
 * @param clickStats 鎸?query/path 缁勭粐鐨勭偣鍑荤紦瀛樸€? * @param query 鍘熷鏌ヨ鏂囨湰銆? * @param path 鍘熷璺緞銆? * @returns void
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
 * 蹇€熸悳绱㈢偣鍑荤粺璁¤兘鍔涖€? * 璐熻矗鎸夌偣鍑绘鏁伴噸鎺掔粨鏋滐紝骞跺湪鐐瑰嚮鍚庡啓鍏?SQLite锛堥€氳繃 query 灏佽灞傦級銆? *
 * @returns 鐐瑰嚮缁熻鐩稿叧鏂规硶闆嗗悎銆? */
export function useQuickSearchClickStats() {
    // 鏈湴缂撳瓨锛氭寜瑙勮寖鍖?query 缂撳瓨 path->count锛岄伩鍏嶆瘡娆℃悳绱㈤兘璇诲簱銆?    const clickStats: ClickStatsMap = {};
    // 鍚屼竴 query 鐨勫苟鍙戦鍙?鎺掑簭鍏变韩涓€娆¤鍙栥€?    const pendingLoads = new Map<string, Promise<Record<string, number>>>();

    async function ensureClickStats(queryNorm: string): Promise<Record<string, number>> {
        const cached = clickStats[queryNorm];
        if (cached) {
            return cached;
        }

        const pending = pendingLoads.get(queryNorm);
        if (pending) {
            return await pending;
        }

        const load = (async (): Promise<Record<string, number>> => {
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
                return pathStats;
            } catch (error) {
                log.warn('[QuickSearchPanel] Failed to load click stats from sqlite:', error);
                clickStats[queryNorm] = {};
                return clickStats[queryNorm]!;
            } finally {
                pendingLoads.delete(queryNorm);
            }
        })();

        pendingLoads.set(queryNorm, load);
        return await load;
    }

    /**
     * 鎻愬墠鍔犺浇鐐瑰嚮缁熻锛屼娇 native 鎼滅储涓庤交閲忛噸鎺掑彲浠ュ苟琛屻€?     * 璇诲彇澶辫触涓嶆姏鍑猴細鎺掑簭浠嶅洖閫€鍒板師濮嬬粨鏋溿€?     */
    async function prefetch(query: string): Promise<void> {
        const queryNorm = normalizeClickQuery(query);
        if (!queryNorm) {
            return;
        }

        await ensureClickStats(queryNorm);
    }

    /**
     * 鎸夌偣鍑荤粺璁″鎼滅储缁撴灉鍋氱ǔ瀹氶噸鎺掋€?     *
     * @param query 褰撳墠鏌ヨ鏂囨湰銆?     * @param items 鍘熷鎼滅储缁撴灉銆?     * @returns 閲嶆帓鍚庣殑鎼滅储缁撴灉銆?     */
    async function rankResults(
        query: string,
        items: QuickShortcutItem[]
    ): Promise<QuickShortcutItem[]> {
        const queryNorm = normalizeClickQuery(query);
        if (!queryNorm) {
            return items;
        }

        // 鎳掑姞杞斤細棣栨鍛戒腑鏌?query 鏃跺啀璇诲彇 SQLite锛屽苟鍥炲～鍒板唴瀛樼紦瀛樸€?        const pathStats = await ensureClickStats(queryNorm);
        let hasClickBoost = false;
        // 璁板綍鍘熷绱㈠紩锛屽悗缁悓鍒嗘椂鎸夊師椤哄簭鍥為€€锛屼繚鎸佺ǔ瀹氭帓搴忋€?        const ranked = items.map((item, index) => {
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
     * 璁板綍涓€娆＄偣鍑昏涓恒€?     * 鍏堟洿鏂板唴瀛樼紦瀛橈紝鍐嶅紓姝ユ寔涔呭寲鍒?SQLite銆?     *
     * @param query 褰撳墠鏌ヨ鏂囨湰銆?     * @param path 琚偣鍑婚」璺緞銆?     * @returns void
     */
    function recordClick(query: string, path: string) {
        updateClickStatsCache(clickStats, query, path);

        const queryNorm = normalizeClickQuery(query);
        const pathNorm = normalizeClickPath(path);
        if (!queryNorm || !pathNorm) {
            return;
        }

        // 鍐欏簱璧版煡璇㈠眰灏佽锛涘け璐ヤ粎璁板綍鏃ュ織锛屼笉闃诲涓绘祦绋嬨€?        void upsertQuickSearchClick({
            queryNorm,
            pathNorm,
            maxClickCount: MAX_CLICK_COUNT,
        }).catch((error) =>
            log.warn('[QuickSearchPanel] Failed to record click to sqlite:', error)
        );
    }

    return {
        prefetch,
        rankResults,
        recordClick,
    };
}
