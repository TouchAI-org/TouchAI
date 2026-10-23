// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Calendar model for the activity heatmap.
 *
 * Ported from uiarc's activity-heatmap: lays one value per day onto a calendar
 * of weeks by weekdays and buckets values into five levels. Levels split at
 * quarters of the busiest day rather than by quantile, because the reader is
 * after relative intensity, not a ranking.
 */

export interface ActivityDay {
    /** YYYY-MM-DD */
    date: string;
    count: number;
}

export interface ActivityModel {
    /** UTC milliseconds of the first day. */
    start: number;
    /** Number of days covered. */
    length: number;
    /** Empty cells before the first day. */
    lead: number;
    weeks: number;
    total: number;
    counts: number[];
    levels: number[];
    thresholds: [number, number, number];
    months: Array<{ column: number; label: string }>;
    /** Days sitting at each level. */
    perLevel: number[];
}

const DAY = 86_400_000;

/** Parse YYYY-MM-DD as UTC milliseconds so a local zone cannot shift the day. */
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
 * Build the calendar model.
 *
 * @param days one entry per day; missing days count as 0
 * @param weekStartsOn 0 for Sunday, 1 for Monday
 * @param thresholds upper bounds for the first three levels; defaults to 25/50/75% of the busiest day
 * @param monthName short month formatter
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
    // A partial first month keeps its label only with three columns of room.
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

/** Grid column and row for one day index. */
export function slotOf(model: ActivityModel, index: number): { column: number; row: number } {
    const offset = model.lead + index;
    return { column: Math.floor(offset / 7), row: offset % 7 };
}

/** Grid size in columns and rows. */
export function gridSize(model: ActivityModel): { columns: number; rows: number } {
    return { columns: Math.max(1, model.weeks), rows: 7 };
}

/**
 * Index step for keyboard navigation: left and right move by day, up and down
 * by week, matching a calendar. Home and End jump to the ends.
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
