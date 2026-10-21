// Copyright (c) 2026. 千诚. Licensed under GPL v3

/**
 * 堆叠柱的几何与刻度。
 *
 * 移植自 uiarc 的 bar-chart：柱顶是「数据端」——圆角只给最后一段，
 * 基线一侧保持方角，这样堆叠的柱子看起来是一根整体的柱，而不是几块积木。
 */

export type Segment = { key: string; value: number; color: string };

export interface Column {
    key: string;
    label: string;
    /** 轴上的短标签，缺省时不显示 */
    axisLabel?: string;
    segments: Segment[];
}

/** 柱顶圆角的最大值 */
const RADIUS = 4;

/**
 * 一根柱子的路径。
 *
 * 最后一段（最上面那段）带圆角，其余段是方角矩形，
 * 段与段之间留一点缝，让堆叠关系看得出来。
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
 * 「好看」的刻度。
 *
 * 与折线图同一套步长（1/2/2.5/5 × 10^n），保证两张图的纵轴读起来一致。
 * 返回上限与刻度数组：刻度都是步长的整数倍，不会出现 0/75/150 这种读数。
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

/** 只取上限，供调用点算比例 */
export function niceMax(value: number): number {
    return niceScale(value).max;
}

/**
 * 只显示放得下的轴标签。
 *
 * 从最新一根往左数，保证最新的那个一定有标签（读者最关心它），
 * 间距也保持均匀。
 */
export function fittingLabels(count: number, availableWidth: number, labelWidth = 34): number[] {
    if (count <= 0) return [];
    const slot = availableWidth / count;
    const stride = Math.max(1, Math.ceil((labelWidth + 8) / slot));
    const picked: number[] = [];
    for (let index = count - 1; index >= 0; index -= stride) picked.push(index);
    return picked.reverse();
}
