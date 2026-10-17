// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { UsageFilter, UsageRangePreset } from '@database/queries/usageStats';

/** 时间范围选项在界面上出现的顺序 */
export const USAGE_RANGE_PRESETS: UsageRangePreset[] = [
    'today',
    '24h',
    '7d',
    '30d',
    'all',
    'custom',
];

/**
 * 转成数据库时间戳格式（`YYYY-MM-DD HH:MM:SS`，UTC）。
 *
 * 数据库里的 `created_at` 由 `datetime('now')` 写入，是 UTC。
 * 所有范围比较必须用同一时区，否则会偏差一整个时区宽度。
 * 展示与按天分桶时再转回本地时区（SQL 里的 `'localtime'`）。
 */
export function toDbRangeString(date: Date): string {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** 把预设解析成具体的起止时间（数据库时间戳格式） */
export function resolveUsageRange(
    preset: UsageRangePreset,
    custom?: { from?: string; to?: string }
): Pick<UsageFilter, 'from' | 'to'> {
    const now = new Date();
    const to = toDbRangeString(now);

    switch (preset) {
        case 'today': {
            // 本地今天的零点
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            return { from: toDbRangeString(start), to };
        }
        case '24h':
            return { from: toDbRangeString(new Date(now.getTime() - 24 * 60 * 60 * 1000)), to };
        case '7d':
            return { from: toDbRangeString(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)), to };
        case '30d':
            return {
                from: toDbRangeString(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)),
                to,
            };
        case 'all':
            return { from: '1970-01-01 00:00:00', to: '9999-12-31 23:59:59' };
        case 'custom': {
            const fallbackFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            return {
                from: custom?.from ?? toDbRangeString(fallbackFrom),
                to: custom?.to ?? to,
            };
        }
        default:
            return { from: toDbRangeString(new Date(now.getTime() - 24 * 60 * 60 * 1000)), to };
    }
}
