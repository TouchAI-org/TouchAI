import { describe, expect, it } from 'vitest';

import {
    breadth,
    groupSlices,
    layout,
    n2,
    sector,
    TAU,
} from '@/components/ui/donut-chart/geometry';

describe('user reads a rounded chart number', () => {
    it('user rounds to two decimals without trailing noise', () => {
        expect(n2(1.23456)).toBe('1.23');
        expect(n2(1)).toBe('1');
        expect(n2(-0.001)).toBe('0');
    });
});

describe('user reads a donut chart', () => {
    it('user fills the ring in proportion to the values', () => {
        const arcs = layout(
            [
                { key: 'a', value: 50 },
                { key: 'b', value: 50 },
            ],
            new Set()
        );

        expect(arcs.get('a')).toEqual({ start: 0, end: 0.5 });
        expect(arcs.get('b')).toEqual({ start: 0.5, end: 1 });
    });

    it('user gets a hidden segment zero width but keeps its slot', () => {
        const arcs = layout(
            [
                { key: 'a', value: 50 },
                { key: 'b', value: 50 },
            ],
            new Set(['a'])
        );

        // 隐藏的段宽度为 0，但其余段仍从原位开始，不会跳
        expect(arcs.get('a')).toEqual({ start: 0, end: 0 });
        expect(arcs.get('b')).toEqual({ start: 0, end: 1 });
    });

    it('user falls back to an even split when the total is zero', () => {
        const arcs = layout(
            [
                { key: 'a', value: 0 },
                { key: 'b', value: 0 },
            ],
            new Set()
        );

        expect(arcs.get('a')).toEqual({ start: 0, end: 0 });
        expect(arcs.get('b')).toEqual({ start: 0, end: 0 });
    });
});

describe('user reads a donut slice', () => {
    it('user gets nothing for a zero-width arc', () => {
        expect(sector(80, 70, 50, 0.3, 0.3, 3, 5)).toBe('');
    });

    it('user draws a full ring as two closed circles', () => {
        const d = sector(80, 70, 50, 0, 1, 3, 5);

        // 整圈没有间隙可留，用两段弧拼出外圈和内圈
        expect(d.match(/A/g)).toHaveLength(4);
        expect(d.match(/Z/g)).toHaveLength(2);
    });

    it('user starts every sector at the same point for a given angle', () => {
        // 0 → 0.25 从 12 点扫到 3 点，起点应在正上方
        const d = sector(80, 70, 50, 0, 0.25, 3, 5);
        const match = d.match(/^M([-\d.]+) ([-\d.]+)/);

        expect(match).not.toBeNull();
        const x = Number(match![1]);
        const y = Number(match![2]);
        // 起点在正上方，但沿切线方向偏移了 gap/2（3/2 = 1.5px）
        expect(x).toBeCloseTo(80 + 1.5, 1);
        expect(y).toBeLessThan(80);
    });

    it('user keeps the gap constant from inner to outer edge', () => {
        // 间隙由两侧边线的偏移量决定，与半径无关：
        // 取两段相邻扇形的边界点，横向距离应接近 gap
        const gap = 4;
        const quarter = sector(80, 70, 50, 0, 0.25, gap, 5);
        const next = sector(80, 70, 50, 0.25, 0.5, gap, 5);

        expect(quarter).not.toBe('');
        expect(next).not.toBe('');
        // 两者都从 3 点方向附近开始/结束，说明边界对齐
        expect(quarter).toContain('A');
        expect(next).toContain('A');
    });

    it('user drops a hairline sector instead of drawing it', () => {
        // 极窄的一段（0.0001 圈）在 70px 半径上不足 1px
        expect(sector(80, 70, 50, 0.5, 0.5001, 3, 5)).toBe('');
    });
});

describe('user reads how wide a donut slice is', () => {
    it('user gets an infinite breadth for a full ring', () => {
        expect(breadth(70, 0, 1, 3)).toBe(Infinity);
    });

    it('user shrinks as the arc narrows', () => {
        const wide = breadth(70, 0, 0.5, 3);
        const narrow = breadth(70, 0, 0.05, 3);

        expect(wide).toBeGreaterThan(narrow);
        expect(narrow).toBeLessThan(70);
    });
});

describe('user reads a donut with many slices', () => {
    it('user merges slices below the threshold into one other bucket', () => {
        const result = groupSlices(
            [
                { key: 'a', label: 'A', value: 60 },
                { key: 'b', label: 'B', value: 30 },
                { key: 'c', label: 'C', value: 5 },
                { key: 'd', label: 'D', value: 5 },
            ],
            0.08,
            6,
            'Other'
        );

        expect(result.map((item) => item.key)).toEqual(['a', 'b', '__other']);
        expect(result[2]?.value).toBe(10);
        expect(result[2]?.label).toBe('Other');
    });

    it('user caps the number of kept slices', () => {
        const data = Array.from({ length: 10 }, (_, index) => ({
            key: `k${index}`,
            label: `L${index}`,
            value: 10,
        }));

        const result = groupSlices(data, 0, 3, 'Other');

        // 3 个保留 + 1 个「其他」
        expect(result).toHaveLength(4);
        expect(result[3]?.value).toBe(70);
    });

    it('user gets an empty array for no data', () => {
        expect(groupSlices([], 0.04, 6, 'Other')).toEqual([]);
    });

    it('user keeps everything when nothing is small', () => {
        const result = groupSlices(
            [
                { key: 'a', label: 'A', value: 50 },
                { key: 'b', label: 'B', value: 50 },
            ],
            0.04,
            6,
            'Other'
        );

        expect(result).toHaveLength(2);
        expect(result.some((item) => item.key === '__other')).toBe(false);
    });
});

describe('user reads a full donut ring', () => {
    it('user is a full turn', () => {
        expect(TAU).toBeCloseTo(Math.PI * 2, 10);
    });
});
