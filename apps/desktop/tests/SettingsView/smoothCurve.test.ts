import { describe, expect, it } from 'vitest';

import { smoothThrough } from '@/views/SettingsView/components/Usage/utils/smoothCurve';

describe('user reads a smoothed curve', () => {
    it('user keeps the original endpoints', () => {
        const points = smoothThrough([
            [0, 10],
            [0.5, 50],
            [1, 20],
        ]);

        expect(points[0]).toEqual([0, 10]);
        expect(points[points.length - 1]![1]).toBeCloseTo(20, 5);
    });

    it('user never overshoots a segment, so a spike has no fake dip', () => {
        const points = smoothThrough([
            [0, 0],
            [0.25, 0],
            [0.5, 100],
            [0.75, 100],
            [1, 100],
        ]);

        for (const [, value] of points) {
            expect(value).toBeGreaterThanOrEqual(-0.001);
            expect(value).toBeLessThanOrEqual(100.001);
        }
    });

    it('user drops duplicate x so the tangent division stays finite', () => {
        const points = smoothThrough([
            [0, 5],
            [0.5, 10],
            [0.5, 90],
            [1, 20],
        ]);

        for (const [, value] of points) {
            expect(Number.isFinite(value)).toBe(true);
        }
    });

    it('user gets a flat line for a single point', () => {
        expect(smoothThrough([[0, 42]])).toEqual([
            [0, 42],
            [1, 42],
        ]);
    });

    it('user gets nothing for no input', () => {
        expect(smoothThrough([])).toEqual([]);
    });
});
