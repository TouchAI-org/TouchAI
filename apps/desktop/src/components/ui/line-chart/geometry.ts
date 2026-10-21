// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 折线图的几何与刻度。
 *
 * 移植自 uiarc 的 line-chart：单调三次插值保证平滑曲线不会冲出数据范围
 * （普通的 Catmull-Rom 会在陡升处「过冲」，画出根本不存在的峰值）。
 */

export type Point = [x: number, value: number];

/** 去掉浮点噪声：0.30000000000000004 → 0.3 */
export function clean(value: number): number {
    return Number(value.toPrecision(12));
}

export interface Scale {
    min: number;
    max: number;
    ticks: number[];
}

/**
 * 选出「好看」的刻度。
 *
 * 步长取 1 / 2 / 2.5 / 5 × 10^n，让刻度落在整数上；
 * 下限从 0 开始（除非数据有负值），最多 4 格。
 */
export function niceScale(low: number, high: number): Scale {
    const lo = Math.min(0, low);
    const hi = Math.max(high, lo + 1);
    const span = hi - lo;
    const magnitude = 10 ** Math.floor(Math.log10(span / 4));

    for (const factor of [1, 2, 2.5, 5, 10]) {
        const step = factor * magnitude;
        const bottom = Math.floor(lo / step) * step;
        const top = Math.ceil(hi / step) * step;
        if ((top - bottom) / step <= 4 + 1e-9) {
            const ticks: number[] = [];
            for (let value = bottom; value <= top + step / 2; value += step) {
                ticks.push(clean(value));
            }
            return { min: clean(bottom), max: clean(top), ticks };
        }
    }

    return { min: lo, max: hi, ticks: [lo, hi] };
}

/**
 * 单调三次插值，把折线变成平滑曲线。
 *
 * x 归一化到 0–1，返回密集采样点。
 * 切线用 Fritsch–Carlson 约束：曲线不会在两个数据点之间冲出它们的值域。
 */
export function curveFor(values: readonly number[], smooth: boolean): Point[] {
    if (values.length === 0) return [];
    if (values.length === 1) {
        return [
            [0, values[0]!],
            [1, values[0]!],
        ];
    }

    const last = values.length - 1;
    const step = 1 / last;
    if (!smooth) return values.map((value, index) => [index * step, value]);

    const slopes = values.slice(1).map((value, index) => (value - values[index]!) / step);

    const tangents = values.map((_, index) => {
        if (index === 0 || index === last) return 0;
        const before = slopes[index - 1]!;
        const after = slopes[index]!;
        const sameDirection = Math.sign(before) + Math.sign(after);
        const limited =
            Math.min(Math.abs(before), Math.abs(after), Math.abs(before + after) / 4) *
            sameDirection;
        return limited || 0;
    });

    if (last > 1) {
        tangents[0] = (3 * slopes[0]! - tangents[1]!) / 2;
        tangents[last] = (3 * slopes[last - 1]! - tangents[last - 1]!) / 2;
    } else {
        tangents[0] = slopes[0]!;
        tangents[1] = slopes[0]!;
    }

    // 每段最多采样 16 点：太多没意义，太少会看出折角
    const samples = Math.max(1, Math.min(16, Math.round(192 / last)));
    const points: Point[] = [];

    for (let index = 0; index < last; index += 1) {
        const x0 = index * step;
        const x1 = (index + 1) * step;
        const v0 = values[index]!;
        const v1 = values[index + 1]!;
        const m0 = tangents[index]! * step;
        const m1 = tangents[index + 1]! * step;

        for (let sample = 0; sample < samples; sample += 1) {
            const t = sample / samples;
            const t2 = t * t;
            const t3 = t2 * t;
            // Hermite 基函数
            const h00 = 2 * t3 - 3 * t2 + 1;
            const h10 = t3 - 2 * t2 + t;
            const h01 = -2 * t3 + 3 * t2;
            const h11 = t3 - t2;
            points.push([x0 + (x1 - x0) * t, h00 * v0 + h10 * m0 + h01 * v1 + h11 * m1]);
        }
    }

    points.push([1, values[last]!]);
    return points;
}

/**
 * 把归一化曲线映射到画布坐标。
 *
 * @param width 绘图区宽度
 * @param height 绘图区高度
 */
export function toPath(
    points: readonly Point[],
    scale: Scale,
    width: number,
    height: number
): string {
    if (points.length === 0) return '';
    const span = scale.max - scale.min || 1;

    return points
        .map(([x, value], index) => {
            const px = x * width;
            const py = height - ((value - scale.min) / span) * height;
            return `${index === 0 ? 'M' : 'L'}${px.toFixed(2)},${py.toFixed(2)}`;
        })
        .join(' ');
}

/**
 * 单调三次插值，允许 x 不等距。
 *
 * `curveFor` 假定采样均匀，适合按下标等距的历史桶；实时曲线的采样间隔
 * 不均匀（窗口裁掉了左边缘的点），需要按真实时间插值，否则线会抽。
 */
export function smoothThrough(points: readonly Point[]): Point[] {
    if (points.length === 0) return [];
    if (points.length === 1) return [points[0]!, [1, points[0]![1]]];

    // x 必须严格递增，重复的点会让切线除法炸掉
    const sorted: Point[] = [];
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

    const out: Point[] = [sorted[0]!];
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
            // 单调插值不该冲出两端，夹一下消除浮点误差
            out.push([x0 + dx * t, Math.min(Math.max(value, Math.min(v0, v1)), Math.max(v0, v1))]);
        }
    }

    return out;
}

/** 折线下方的填充区域：把曲线接到基线上 */
export function toAreaPath(
    points: readonly Point[],
    scale: Scale,
    width: number,
    height: number
): string {
    const line = toPath(points, scale, width, height);
    if (!line) return '';
    const last = points[points.length - 1]!;
    return `${line} L${(last[0] * width).toFixed(2)},${height} L0,${height} Z`;
}
