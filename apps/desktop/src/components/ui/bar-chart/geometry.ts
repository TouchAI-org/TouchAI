// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Geometry and scale for the stacked bar chart.
 *
 * The top of a column is the data end: only the last segment gets rounded
 * corners while the baseline side stays square, so a stacked column reads as
 * one bar rather than a pile of blocks.
 */

export type Segment = { key: string; value: number; color: string };

export interface Column {
    key: string;
    label: string;
    /** Short axis label; omitted when absent. */
    axisLabel?: string;
    segments: Segment[];
}

/** Maximum corner radius at the top of a column. */
const RADIUS = 4;

/**
 * Path for one column.
 *
 * The last (topmost) segment is rounded while the rest stay square, and a small
 * gap between segments keeps the stacking readable.
 */
export function columnPath(
    x: number,
    width: number,
    top: number,
    height: number,
    round: boolean
): string {
    if (width <= 0 || height <= 0.5) return '';

    const base = top + height;
    const f = (value: number) => value.toFixed(2);
    if (!round) {
        return `M${f(x)} ${f(base)}V${f(top)}H${f(x + width)}V${f(base)}Z`;
    }

    const r = Math.min(RADIUS, width / 2, height);
    return [
        `M${f(x)} ${f(base)}`,
        `V${f(top + r)}`,
        `A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(top)}`,
        `H${f(x + width - r)}`,
        `A${f(r)} ${f(r)} 0 0 1 ${f(x + width)} ${f(top + r)}`,
        `V${f(base)}`,
        'Z',
    ].join('');
}

/**
 * A "nice" scale.
 *
 * Uses steps of 1/2/2.5/5 x 10^n so the y axis reads the same as the line
 * chart. Returns the top plus the tick list: every tick is a multiple of the
 * step, so labels never come out as 0/75/150.
 */
export function niceScale(value: number): { max: number; ticks: number[] } {
    if (!Number.isFinite(value) || value <= 0) return { max: 1, ticks: [0, 1] };

    const magnitude = 10 ** Math.floor(Math.log10(value / 4));
    for (const factor of [1, 2, 2.5, 5, 10]) {
        const step = factor * magnitude;
        const count = Math.ceil(value / step);
        if (count <= 4 + 1e-9) {
            const max = count * step;
            const ticks: number[] = [];
            for (let index = 0; index <= count; index += 1) {
                ticks.push(Number((index * step).toPrecision(12)));
            }
            return { max: Number(max.toPrecision(12)), ticks };
        }
    }

    return { max: Math.ceil(value), ticks: [0, Math.ceil(value)] };
}

/** Top only, for call sites that just need a ratio. */
export function niceMax(value: number): number {
    return niceScale(value).max;
}

/**
 * Axis labels that actually fit.
 *
 * Counts back from the newest bar so the latest one is always labelled (it is
 * what the reader cares about) while spacing stays even.
 */
export function fittingLabels(count: number, availableWidth: number, labelWidth = 34): number[] {
    if (count <= 0) return [];
    const slot = availableWidth / count;
    const stride = Math.max(1, Math.ceil((labelWidth + 8) / slot));
    const picked: number[] = [];
    for (let index = count - 1; index >= 0; index -= stride) picked.push(index);
    return picked.reverse();
}
