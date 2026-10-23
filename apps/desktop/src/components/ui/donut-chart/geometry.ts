// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Annular sector geometry.
 *
 * Uses pixel gaps plus rounded sectors rather than stroke-dasharray, which
 * cannot express a gap between segments and leaves them touching. Both edges
 * are offset by gap/2 along the radius, so the gap is constant from the inner
 * radius to the outer one.
 */

export const TAU = Math.PI * 2;

/** Two decimals: more precision in an SVG path only lengthens the string. */
export function n2(value: number): string {
    return (Math.round(value * 100) / 100).toString();
}

export interface Arc {
    start: number;
    end: number;
}

/**
 * Lay the slice values out as arc ranges in 0..1.
 *
 * A hidden slice keeps its slot at zero width, so it returns to the same place
 * when shown again and the other slices do not reflow.
 */
export function layout(
    slices: ReadonlyArray<{ key: string; value: number }>,
    hidden: ReadonlySet<string>
): Map<string, Arc> {
    const total =
        slices.reduce((sum, item) => sum + (hidden.has(item.key) ? 0 : item.value), 0) || 1;
    let at = 0;
    return new Map(
        slices.map((item) => {
            const arc = { start: at, end: at + (hidden.has(item.key) ? 0 : item.value / total) };
            at = arc.end;
            return [item.key, arc];
        })
    );
}

/**
 * Half the breadth of a sector's outer edge, in pixels.
 *
 * Below a pixel or two the sector fades out instead of drawing a hairline that
 * only adds visual noise.
 */
export function breadth(R: number, t0: number, t1: number, gap: number): number {
    const turns = t1 - t0;
    if (turns >= 1 - 1e-6) return Infinity;
    return (
        Math.sin(Math.min(turns * Math.PI, Math.PI / 2)) * R -
        Math.min((gap / 2) * 1, ((1 - turns) * TAU * R) / 2)
    );
}

/**
 * One rounded annular sector.
 *
 * @param c centre coordinate; the viewBox is square, so x and y match
 * @param R outer radius
 * @param r inner radius
 * @param t0 start position in 0..1, clockwise from twelve o'clock
 * @param t1 end position
 * @param gap pixel gap between neighbouring slices
 * @param corner corner radius
 */
export function sector(
    c: number,
    R: number,
    r: number,
    t0: number,
    t1: number,
    gap: number,
    corner: number
): string {
    const turns = t1 - t0;
    if (turns <= 1e-6) return '';

    const at = (radius: number, angle: number) =>
        `${n2(c + radius * Math.cos(angle))} ${n2(c + radius * Math.sin(angle))}`;

    // Full circle: two complete rings, no gap needed.
    if (turns >= 1 - 1e-6) {
        return (
            `M${at(R, -Math.PI / 2)}A${n2(R)} ${n2(R)} 0 1 1 ${at(R, Math.PI / 2)}` +
            `A${n2(R)} ${n2(R)} 0 1 1 ${at(R, -Math.PI / 2)}Z` +
            `M${at(r, -Math.PI / 2)}A${n2(r)} ${n2(r)} 0 1 0 ${at(r, Math.PI / 2)}` +
            `A${n2(r)} ${n2(r)} 0 1 0 ${at(r, -Math.PI / 2)}Z`
        );
    }

    // Half a gap on each side; a lone slice closes into a full ring without a jump.
    const p = Math.min(gap / 2, ((1 - turns) * TAU * R) / 2);
    const a0 = t0 * TAU - Math.PI / 2;
    const a1 = t1 * TAU - Math.PI / 2;
    const half = (a1 - a0) / 2;
    const s = Math.sin(Math.min(half, Math.PI / 2));
    // Too narrow to draw: let the caller fade it out instead of drawing a line.
    if (s * R <= p + 1e-6) return '';

    /** Endpoint of an edge line offset by `p` along the radius. */
    const side = (t: number, angle: number, sign: number) =>
        `${n2(c + t * Math.cos(angle) - sign * p * Math.sin(angle))} ` +
        `${n2(c + t * Math.sin(angle) + sign * p * Math.cos(angle))}`;

    const band = (R - r) / 2;
    const ro = Math.max(0, Math.min(corner, band, s >= 0.9999 ? Infinity : (s * R - p) / (1 + s)));
    const dO = Math.asin(Math.min(1, (p + ro) / (R - ro)));
    const tO = Math.sqrt(Math.max(0, (R - ro) ** 2 - (p + ro) ** 2));
    const bigO = a1 - a0 - 2 * dO > Math.PI ? 1 : 0;

    let d = `M${side(tO, a0, 1)}`;
    if (ro > 0.01) d += `A${n2(ro)} ${n2(ro)} 0 0 1 ${at(R, a0 + dO)}`;
    d += `A${n2(R)} ${n2(R)} 0 ${bigO} 1 ${at(R, a1 - dO)}`;
    if (ro > 0.01) d += `A${n2(ro)} ${n2(ro)} 0 0 1 ${side(tO, a1, -1)}`;

    if (s * r > p + 1e-6 || s >= 0.9999) {
        const ri = Math.max(
            0,
            Math.min(corner, band, s >= 0.9999 ? Infinity : (s * r - p) / (1 - s))
        );
        const dI = Math.asin(Math.min(1, (p + ri) / (r + ri)));
        const tI = Math.sqrt(Math.max(0, (r + ri) ** 2 - (p + ri) ** 2));
        const bigI = a1 - a0 - 2 * dI > Math.PI ? 1 : 0;

        d += `L${side(tI, a1, -1)}`;
        if (ri > 0.01) d += `A${n2(ri)} ${n2(ri)} 0 0 1 ${at(r, a1 - dI)}`;
        d += `A${n2(r)} ${n2(r)} 0 ${bigI} 0 ${at(r, a0 + dI)}`;
        if (ri > 0.01) d += `A${n2(ri)} ${n2(ri)} 0 0 1 ${side(tI, a0, 1)}`;
    } else {
        // The inner edge is too narrow, so it collapses to a point.
        d += `L${at(p / s, (a0 + a1) / 2)}`;
    }

    return `${d}Z`;
}

/**
 * Grouping: slices below the threshold merge into "other".
 *
 * Without it a long tail cuts the ring into a dozen hairlines that show no
 * proportion and cannot be clicked.
 */
export function groupSlices<
    T extends { key: string; label: string; value: number; color?: string },
>(
    data: readonly T[],
    groupBelow: number,
    maxSegments: number,
    otherLabel: string,
    otherKey = '__other'
): Array<{ key: string; label: string; value: number; color?: string }> {
    if (data.length === 0) return [];

    const total = data.reduce((sum, item) => sum + item.value, 0) || 1;
    const kept: Array<{ key: string; label: string; value: number; color?: string }> = [];
    let otherValue = 0;

    for (const item of data) {
        const tooSmall = item.value / total < groupBelow;
        const overflow = kept.length >= maxSegments;
        if (tooSmall || overflow) otherValue += item.value;
        else kept.push({ ...item });
    }

    if (otherValue > 0) {
        kept.push({ key: otherKey, label: otherLabel, value: otherValue });
    }
    return kept;
}
