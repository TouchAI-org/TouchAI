// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { StatisticKey } from '@database/schema';
import { native } from '@services/NativeService';
import { log } from '@services/ObservabilityService';

/** 两次维护之间的最短间隔。 */
const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

/** 明细保留天数。0 表示永久保留。 */
export const DEFAULT_DETAIL_RETENTION_DAYS = 0;

/** 把回合级用量汇总成按天 × 模型 × 供应商的持久聚合。 */
export async function rollupUsageDaily(): Promise<void> {
    await native.database.operation({ kind: 'usage_rollup_daily' });
}

/**
 * 清理超过保留期的调用明细。
 *
 * 只删 `llm_call` 片段；回合级聚合、日汇总、对话正文都不受影响。
 */
export async function pruneUsageDetail(retentionDays: number): Promise<number> {
    return native.database.operation<number>({
        kind: 'usage_prune_detail',
        retentionDays,
    });
}

/**
 * 启动时执行一次用量维护：先汇总，再按保留策略清理明细。
 *
 * Rust 在一个写事务里完成节流判断、rollup、prune 和运行时间戳更新，避免
 * 多次 IPC 之间出现半完成状态。失败只记录日志，不影响应用启动。
 */
export async function runUsageMaintenance(
    retentionDays = DEFAULT_DETAIL_RETENTION_DAYS
): Promise<void> {
    try {
        const result = await native.database.operation<{ ran: boolean; pruned: number }>({
            kind: 'usage_maintenance',
            retentionDays,
            minIntervalMs: MAINTENANCE_INTERVAL_MS,
            now: new Date().toISOString(),
            statisticKey: StatisticKey.USAGE_MAINTENANCE_RUN_AT,
        });
        if (result.pruned > 0) {
            log.debug(`[UsageMaintenance] Pruned ${result.pruned} expired call parts`);
        }
    } catch (error) {
        log.error('[UsageMaintenance] Failed to run usage maintenance:', error);
    }
}
