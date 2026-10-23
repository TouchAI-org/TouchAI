// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Vertical axis for the live curve.
 *
 * Live throughput is dominated by one cold-start burst of several hundred
 * tok/s, after which it settles into tens with occasional drops to zero on
 * tool calls. On a linear scale that burst pins everything else to the floor.
 *
 * A square-root transform keeps the values honest — nothing is clipped, the
 * order is preserved, and ratios between any two points are unchanged — while
 * lifting the low end and compressing the high end so the movement is visible.
 * Tick labels still show true values; only their positions are transformed.
 */

/** Axis floor, so idle noise at 0.1 tok/s does not fill the plot. */
const FLOOR = 10;

/** Height fraction (0..1) for a value, monotone and never clipping. */
export function compressRatio(value: number, axisMax: number): number {
    if (!(axisMax > 0)) return 0;
    return Math.sqrt(Math.max(0, value) / axisMax);
}

/** Round step (1/2/2.5/5 x 10^n) that splits the peak into about three rows. */
export function niceStep(peak: number): number {
    const raw = Math.max(1, peak) / 3;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    for (const factor of [1, 2, 2.5, 5, 10]) {
        const step = factor * magnitude;
        if (step >= raw) return step;
    }
    return 10 * magnitude;
}

export interface LiveAxis {
    /** Axis top in real units. */
    max: number;
    /** Ticks: real value plus its transformed height fraction. */
    ticks: Array<{ value: number; ratio: number }>;
}

/**
 * Derive the axis from the values currently in the window.
 *
 * The top is rounded up to a step so the axis does not jitter between frames,
 * yet it still follows the data: a new window produces a new axis.
 */
export function liveAxis(values: readonly number[]): LiveAxis {
    const peak = values.reduce((max, value) => Math.max(max, value), 0);
    const step = niceStep(Math.max(peak, FLOOR));
    const max = Math.max(FLOOR, Math.ceil(peak / step) * step);

    const ticks: Array<{ value: number; ratio: number }> = [];
    for (let value = 0; value <= max + step / 2; value += step) {
        const rounded = Number(value.toPrecision(12));
        ticks.push({ value: rounded, ratio: compressRatio(rounded, max) });
    }

    return { max, ticks };
}

/** Tick label: integers as-is, fractions with one decimal. */
export function formatAxisValue(value: number): string {
    if (!Number.isFinite(value)) return '0';
    return value >= 100 ? String(Math.round(value)) : String(Number(value.toFixed(1)));
}
