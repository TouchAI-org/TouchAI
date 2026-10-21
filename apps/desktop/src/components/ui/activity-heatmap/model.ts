// Copyright (c) 2026. 千诚. Licensed under GPL v3

/**
 * 活动热力图的日历模型。
 *
 * 移植自 uiarc 的 activity-heatmap：把「每天一个数」铺成
 * 「周为列、星期为行」的日历，并把数值分成 0–4 五档。
 * 与参考实现一致，档位默认按「最忙那天的四分之一」切分，
 * 而不是按分位数——读者一眼看到的是相对强度，不是排名。
 */

export interface ActivityDay {
    /** YYYY-MM-DD */
    date: string;
    count: number;
}

export interface ActivityModel {
    /** 首日的 UTC 毫秒 */
    start: number;
    /** 覆盖的天数 */
    length: number;
    /** 第一行之前的空格数 */
    lead: number;
    weeks: number;
    total: number;
    counts: number[];
    levels: number[];
    thresholds: [number, number, number];
    months: Array<{ column: number; label: string }>;
    /** 每档各有多少天 */
    perLevel: number[];
}

const DAY = 86_400_000;

/** 把 YYYY-MM-DD 解析成 UTC 毫秒，避免本地时区把日期挪一天 */
export function toUtc(date: string): number {
    const [year, month, day] = date.split('-').map(Number);
    if (!year || !month || !day) return NaN;
    return Date.UTC(year, month - 1, day);
}

export function toIso(ms: number): string {
    const date = new Date(ms);
    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
    ].join('-');
}

/**
 * 建出日历模型。
 *
 * @param days 每天一条，缺的日子按 0 计
 * @param weekStartsOn 0 = 周日，1 = 周一
 * @param thresholds 自定义三档上界；不传则按最忙那天的 25/50/75%
 * @param monthName 月份短名格式化
 */
export function buildModel(
    days: readonly ActivityDay[],
    weekStartsOn: 0 | 1,
    thresholds: [number, number, number] | undefined,
    monthName: (date: Date) => string
): ActivityModel {
    const dates = days.map((day) => toUtc(day.date)).filter(Number.isFinite);
    const start = dates.length > 0 ? Math.min(...dates) : toUtc('2025-01-01');
    const length = dates.length > 0 ? Math.round((Math.max(...dates) - start) / DAY) + 1 : 0;

    const counts = new Array<number>(length).fill(0);
    for (const day of days) {
        const index = Math.round((toUtc(day.date) - start) / DAY);
        if (index >= 0 && index < length) counts[index]! += Math.max(0, day.count);
    }

    const max = counts.reduce((left, right) => Math.max(left, right), 0);
    const bounds: [number, number, number] = thresholds ?? [
        Math.max(1, Math.ceil(max * 0.25)),
        Math.max(2, Math.ceil(max * 0.5)),
        Math.max(3, Math.ceil(max * 0.75)),
    ];

    const levels = counts.map((count) =>
        count <= 0
            ? 0
            : count <= bounds[0]
              ? 1
              : count <= bounds[1]
                ? 2
                : count <= bounds[2]
                  ? 3
                  : 4
    );

    const lead = (new Date(start).getUTCDay() - weekStartsOn + 7) % 7;
    const weeks = Math.ceil((lead + length) / 7);

    const months: ActivityModel['months'] = [];
    for (let index = 0; index < length; index += 1) {
        const date = new Date(start + index * DAY);
        if (index === 0 || date.getUTCDate() === 1) {
            months.push({
                column: Math.floor((lead + index) / 7),
                label: monthName(date),
            });
        }
    }
    // 首月不完整时，只有与下个月至少隔 3 列才留标签，否则两个标签会叠在一起
    if (months.length > 1 && months[1]!.column - months[0]!.column < 3) months.shift();

    const perLevel = [0, 0, 0, 0, 0];
    for (const level of levels) perLevel[level]! += 1;

    return {
        start,
        length,
        lead,
        weeks,
        total: counts.reduce((sum, value) => sum + value, 0),
        counts,
        levels,
        thresholds: bounds,
        months,
        perLevel,
    };
}

/** 某一格在网格里的列与行 */
export function slotOf(model: ActivityModel, index: number): { column: number; row: number } {
    const offset = model.lead + index;
    return { column: Math.floor(offset / 7), row: offset % 7 };
}

/** 网格尺寸（列 × 行） */
export function gridSize(model: ActivityModel): { columns: number; rows: number } {
    return { columns: Math.max(1, model.weeks), rows: 7 };
}

/**
 * 键盘导航的步长。
 *
 * 左右按天、上下按周，与日历的直觉一致；
 * Home / End 跳到首尾。
 */
export function moveIndex(model: ActivityModel, index: number, key: string): number {
    const last = model.length - 1;
    if (last < 0) return 0;
    if (key === 'ArrowLeft') return Math.max(0, index - 1);
    if (key === 'ArrowRight') return Math.min(last, index + 1);
    if (key === 'ArrowUp') return Math.max(0, index - 7);
    if (key === 'ArrowDown') return Math.min(last, index + 7);
    if (key === 'Home') return 0;
    if (key === 'End') return last;
    return index;
}
