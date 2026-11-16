// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { db } from '@database';
import { getStatistic, setStatistic } from '@database/queries/statistics';
import { StatisticKey } from '@database/schema';
import { log } from '@services/ObservabilityService';
import { sql } from 'drizzle-orm';

import rollupSql from '@/database/artifacts/storage/rollup.sql?raw';

/**
 * 两次维护之间的最短间隔。
 *
 * 汇总会重算全部回合，所以不能每次启动都跑；但「全部时间」趋势读的是这张表，
 * 间隔太长会让曲线看起来停滞。15 分钟在月级跨度上不可见，成本也可控。
 */
const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * 明细保留天数。0 表示永久保留。
 *
 * 目前没有设置项暴露给用户，因此默认永久保留：删除用户数据必须由用户明确授权。
 * 日汇总不受保留策略影响，即使明细被清理，长期趋势仍然完整。
 */
export const DEFAULT_DETAIL_RETENTION_DAYS = 0;

/**
 * 把回合级用量汇总成按天 × 模型 × 供应商的持久聚合。
 *
 * 幂等：同一区间重复执行只会覆盖同名行的数值。
 * 这是明细被清理后唯一还能回答「去年同期花了多少」的数据。
 */
export async function rollupUsageDaily(): Promise<void> {
    await db.run(sql.raw(rollupSql));
}

/**
 * 清理超过保留期的调用明细。
 *
 * 只删 `llm_call` 片段：回合级聚合、日汇总、对话正文都不受影响。
 * `retentionDays <= 0` 时不做任何事。
 *
 * 用 `RETURNING` 而不是 `rowsAffected`：代理驱动只回传 `rows`，
 * 不转递受影响行数，返回行数才是可靠的计数。
 *
 * @returns 实际删除的片段数
 */
export async function pruneUsageDetail(retentionDays: number): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
        return 0;
    }

    const days = Math.floor(retentionDays);
    const removed = await db.all<{ id: number }>(sql`
        DELETE FROM message_parts
        WHERE type = 'llm_call'
          AND created_at < datetime('now', ${`-${days} days`})
        RETURNING id
    `);

    return removed?.length ?? 0;
}

/** 维护是否已经跑过（避免每次启动都全量重算） */
async function isMaintenanceDue(): Promise<boolean> {
    const lastRunAt = await getStatistic({ key: StatisticKey.USAGE_MAINTENANCE_RUN_AT });
    if (!lastRunAt) {
        return true;
    }

    const lastRunMs = Date.parse(lastRunAt);
    if (Number.isNaN(lastRunMs)) {
        return true;
    }

    return Date.now() - lastRunMs >= MAINTENANCE_INTERVAL_MS;
}

/**
 * 启动时执行一次用量维护：先汇总，再按保留策略清理明细。
 *
 * 顺序不能反：明细被删掉之后就无法再汇总出对应的日数据。
 * 失败只记录日志，不能影响应用启动。
 */
export async function runUsageMaintenance(
    retentionDays = DEFAULT_DETAIL_RETENTION_DAYS
): Promise<void> {
    try {
        if (!(await isMaintenanceDue())) {
            return;
        }

        await rollupUsageDaily();
        const pruned = await pruneUsageDetail(retentionDays);
        await setStatistic({
            key: StatisticKey.USAGE_MAINTENANCE_RUN_AT,
            value: new Date().toISOString(),
        });

        if (pruned > 0) {
            log.debug(`[UsageMaintenance] Pruned ${pruned} expired call parts`);
        }
    } catch (error) {
        log.error('[UsageMaintenance] Failed to run usage maintenance:', error);
    }
}
