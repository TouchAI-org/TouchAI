import { describe, expect, it } from 'vitest';

import {
    clean,
    curveFor,
    niceScale,
    toAreaPath,
    toPath,
} from '@/components/ui/line-chart/geometry';

describe('clean', () => {
    it('removes floating point noise', () => {
        expect(clean(0.1 + 0.2)).toBe(0.3);
    });

    it('keeps enough precision for chart ticks', () => {
        // toPrecision(12) 保 12 位有效数字；不要求把任意长尾小数归整
        expect(clean(1.9999999999)).toBeCloseTo(2, 9);
        expect(clean(1234.5678)).toBe(1234.5678);
    });
});

describe('niceScale', () => {
    it('starts from zero and produces at most four steps', () => {
        const scale = niceScale(0, 870);

        expect(scale.min).toBe(0);
        expect(scale.max).toBeGreaterThanOrEqual(870);
        // 最多 4 格，也就是 5 个刻度
        expect(scale.ticks.length).toBeLessThanOrEqual(5);
        expect(scale.ticks[0]).toBe(0);
    });

    it('keeps a negative floor when the data dips below zero', () => {
        const scale = niceScale(-30, 100);

        expect(scale.min).toBeLessThanOrEqual(-30);
    });

    it('uses round steps', () => {
        const scale = niceScale(0, 100);
        const step = scale.ticks[1]! - scale.ticks[0]!;

        // 步长应是 1/2/2.5/5 × 10^n
        expect([1, 2, 2.5, 5, 10, 20, 25, 50, 100]).toContain(step);
    });

    it('handles an all-zero series without dividing by zero', () => {
        const scale = niceScale(0, 0);

        expect(scale.max).toBeGreaterThan(0);
        expect(scale.ticks.length).toBeGreaterThan(1);
    });
});

describe('curveFor', () => {
    it('returns the endpoints unchanged', () => {
        const points = curveFor([10, 50, 20], true);

        expect(points[0]).toEqual([0, 10]);
        expect(points[points.length - 1]).toEqual([1, 20]);
    });

    it('never overshoots the data range on a steep rise', () => {
        // 单调插值的关键性质：曲线不会冲出 [0, 100]
        const points = curveFor([0, 0, 0, 100, 100], true);

        for (const [, value] of points) {
            expect(value).toBeGreaterThanOrEqual(-0.001);
            expect(value).toBeLessThanOrEqual(100.001);
        }
    });

    it('keeps linear mode as straight segments', () => {
        const points = curveFor([0, 10, 5], false);

        expect(points).toEqual([
            [0, 0],
            [0.5, 10],
            [1, 5],
        ]);
    });

    it('handles a single value by drawing a flat line', () => {
        const points = curveFor([42], true);

        expect(points).toEqual([
            [0, 42],
            [1, 42],
        ]);
    });

    it('returns nothing for no data', () => {
        expect(curveFor([], true)).toEqual([]);
    });
});

describe('toPath', () => {
    const scale = { min: 0, max: 100, ticks: [0, 50, 100] };

    it('maps values into the plot box', () => {
        const d = toPath(
            [
                [0, 0],
                [1, 100],
            ],
            scale,
            200,
            100
        );

        // 起点在左下，终点在右上
        expect(d).toBe('M0.00,100.00 L200.00,0.00');
    });

    it('returns an empty string for no points', () => {
        expect(toPath([], scale, 200, 100)).toBe('');
    });
});

describe('toAreaPath', () => {
    it('closes the curve down to the baseline', () => {
        const d = toAreaPath(
            [
                [0, 50],
                [1, 50],
            ],
            { min: 0, max: 100, ticks: [0, 100] },
            200,
            100
        );

        expect(d).toContain('L200.00,100');
        expect(d).toContain('L0,100');
        expect(d.endsWith('Z')).toBe(true);
    });
});
