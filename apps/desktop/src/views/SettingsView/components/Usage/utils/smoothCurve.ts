// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Monotone cubic interpolation for the usage curve.
 *
 * The interpolant never overshoots the endpoints of a segment, so a spike in
 * the data does not produce a dip that never happened. Points are given as
 * `[x, y]` with `x` in 0..1 and must be sorted ascending.
 */
export type CurvePoint = [x: number, y: number];

export function smoothThrough(points: readonly CurvePoint[]): CurvePoint[] {
    if (points.length === 0) return [];
    if (points.length === 1) return [points[0]!, [1, points[0]![1]]];

    // Duplicate or decreasing x breaks the tangent division, so drop them.
    const sorted: CurvePoint[] = [];
    for (const point of points) {
        const last = sorted[sorted.length - 1];
        if (last && point[0] <= last[0]) continue;
        sorted.push(point);
    }
    if (sorted.length < 2) return sorted.length ? [sorted[0]!] : [];

    const slopes = sorted.slice(1).map((point, index) => {
        const previous = sorted[index]!;
        return (point[1] - previous[1]) / (point[0] - previous[0]);
    });

    const last = sorted.length - 1;
    const tangents = sorted.map((_, index) => {
        if (index === 0 || index === last) return 0;
        const before = slopes[index - 1]!;
        const after = slopes[index]!;
        const sameDirection = Math.sign(before) + Math.sign(after);
        return (
            Math.min(Math.abs(before), Math.abs(after), Math.abs(before + after) / 4) *
                sameDirection || 0
        );
    });
    tangents[0] = slopes[0]!;
    tangents[last] = slopes[last - 1]!;

    const out: CurvePoint[] = [sorted[0]!];
    for (let index = 0; index < last; index += 1) {
        const [x0, v0] = sorted[index]!;
        const [x1, v1] = sorted[index + 1]!;
        const dx = x1 - x0;
        const m0 = tangents[index]! * dx;
        const m1 = tangents[index + 1]! * dx;
        const samples = Math.max(2, Math.min(12, Math.round(dx * 160)));

        for (let sample = 1; sample <= samples; sample += 1) {
            const t = sample / samples;
            const t2 = t * t;
            const t3 = t2 * t;
            const value =
                (2 * t3 - 3 * t2 + 1) * v0 +
                (t3 - 2 * t2 + t) * m0 +
                (3 * t2 - 2 * t3) * v1 +
                (t3 - t2) * m1;
            // Clamp away floating point noise; monotone data must stay monotone.
            out.push([x0 + dx * t, Math.min(Math.max(value, Math.min(v0, v1)), Math.max(v0, v1))]);
        }
    }

    return out;
}
