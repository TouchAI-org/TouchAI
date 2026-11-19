import { getStatistic, setStatistic } from '@database/queries/statistics';
import { pruneUsageDetail, rollupUsageDaily } from '@database/queries/usageMaintenance';
import { StatisticKey } from '@database/schema';

import { log } from '@/platform/diagnostics';

export { pruneUsageDetail, rollupUsageDaily } from '@database/queries/usageMaintenance';

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
