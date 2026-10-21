import { describe, expect, it } from 'vitest';

import { columnPath, fittingLabels, niceScale } from '@/components/ui/bar-chart/geometry';

describe('niceScale', () => {
    it('rounds up to a step of 1/2/2.5/5', () => {
        expect(niceScale(870).max).toBe(1000);
        expect(niceScale(100).max).toBe(100);
        // 260 → 步长 100，三格到 300（而不是 4 格到 500）
        expect(niceScale(260)).toEqual({ max: 300, ticks: [0, 100, 200, 300] });
    });

    it('keeps at most four steps', () => {
        for (const value of [1, 7, 33, 120, 870, 4321, 99_999]) {
            const { max, ticks } = niceScale(value);
            expect(max).toBeGreaterThanOrEqual(value);
            expect(ticks.length).toBeLessThanOrEqual(5);
            expect(ticks[0]).toBe(0);
            expect(ticks[ticks.length - 1]).toBe(max);
        }
    });

    it('keeps every tick on a round step', () => {
        const { ticks } = niceScale(260);
        const step = ticks[1]! - ticks[0]!;

        for (const tick of ticks) {
            expect(tick % step).toBe(0);
        }
    });

    it('never returns zero, so the plot cannot divide by zero', () => {
        expect(niceScale(0).max).toBe(1);
        expect(niceScale(-5).max).toBe(1);
    });
});

describe('columnPath', () => {
    it('draws a square rectangle when the segment is not the top one', () => {
        const d = columnPath(10, 20, 50, 30, false);

        expect(d).toBe('M10.00 80.00V50.00H30.00V80.00Z');
        expect(d).not.toContain('A');
    });

    it('rounds the data end only', () => {
        const d = columnPath(10, 20, 50, 30, true);

        // 两个圆弧只出现在顶部两角，基线处仍是直角
        expect((d.match(/A/g) ?? []).length).toBe(2);
        expect(d).toContain('V80.00Z');
    });

    it('caps the radius so a thin bar does not look like a pill', () => {
        const d = columnPath(0, 3, 10, 40, true);

        // r 被压到宽度的一半 = 1.5
        expect(d).toContain('A1.50 1.50');
    });

    it('skips segments too small to draw', () => {
        expect(columnPath(0, 10, 10, 0, true)).toBe('');
        expect(columnPath(0, 0, 10, 10, true)).toBe('');
    });
});

describe('fittingLabels', () => {
    it('keeps the newest label when space is tight', () => {
        const picked = fittingLabels(30, 300, 34);

        // 最新一列（下标 29）一定在里面
        expect(picked).toContain(29);
        // 间距均匀
        const gaps = picked.slice(1).map((value, index) => value - picked[index]!);
        expect(new Set(gaps).size).toBe(1);
    });

    it('shows every label when they fit', () => {
        expect(fittingLabels(5, 600, 34)).toEqual([0, 1, 2, 3, 4]);
    });

    it('returns nothing for no data', () => {
        expect(fittingLabels(0, 300)).toEqual([]);
    });
});
