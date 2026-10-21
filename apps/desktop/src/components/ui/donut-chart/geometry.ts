// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 环形扇形几何。
 *
 * 移植自 uiarc 的 donut-chart：用「像素间隙 + 圆角环形扇形」而不是
 * stroke-dasharray。后者画不出段与段之间的空隙，段之间会粘连；
 * 这里两侧边线沿半径方向各偏移 gap/2，所以从内径到外径的间隙是恒定的。
 */

export const TAU = Math.PI * 2;

/** 数值保留两位小数：SVG path 里再高的精度没有意义，反而让字符串变长 */
export function n2(value: number): string {
    return (Math.round(value * 100) / 100).toString();
}

export interface Arc {
    start: number;
    end: number;
}

/**
 * 把各段的值铺成 0–1 的弧区间。
 *
 * 隐藏的段宽度为 0 但仍占位：这样重新显示时能回到原位，
 * 其余段也不会因为索引变化而重排。
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
 * 扇形外缘的半宽（像素）。
 *
 * 细到只剩一两个像素时不再画发丝线，而是整体淡出，
 * 避免出现视觉噪点。
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
 * 一段带圆角的环形扇形。
 *
 * @param c 圆心坐标（viewBox 是正方形，x/y 相同）
 * @param R 外半径
 * @param r 内半径
 * @param t0 起始位置，0–1，从 12 点顺时针
 * @param t1 结束位置
 * @param gap 相邻段之间的像素间隙
 * @param corner 圆角半径
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

    // 整圈：直接画两个完整的圆，不需要间隙
    if (turns >= 1 - 1e-6) {
        return (
            `M${at(R, -Math.PI / 2)}A${n2(R)} ${n2(R)} 0 1 1 ${at(R, Math.PI / 2)}` +
            `A${n2(R)} ${n2(R)} 0 1 1 ${at(R, -Math.PI / 2)}Z` +
            `M${at(r, -Math.PI / 2)}A${n2(r)} ${n2(r)} 0 1 0 ${at(r, Math.PI / 2)}` +
            `A${n2(r)} ${n2(r)} 0 1 0 ${at(r, -Math.PI / 2)}Z`
        );
    }

    // 两侧各留一半间隙；只剩一段时它会自动合拢成整圈，不会跳变
    const p = Math.min(gap / 2, ((1 - turns) * TAU * R) / 2);
    const a0 = t0 * TAU - Math.PI / 2;
    const a1 = t1 * TAU - Math.PI / 2;
    const half = (a1 - a0) / 2;
    const s = Math.sin(Math.min(half, Math.PI / 2));
    // 太窄了：让调用方淡出，而不是画一条线
    if (s * R <= p + 1e-6) return '';

    /** 沿半径方向偏移 p 的边线端点 */
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
        // 内缘太窄，收成一个尖角
        d += `L${at(p / s, (a0 + a1) / 2)}`;
    }

    return `${d}Z`;
}

/**
 * 分组：占比过小的段合并成「其他」。
 *
 * 不合并的话，长尾会把环切成十几条发丝，既看不出比例也点不中。
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
