import { describe, expect, it } from 'vitest';

import {
    buildModel,
    gridSize,
    moveIndex,
    slotOf,
    toIso,
    toUtc,
} from '@/components/ui/activity-heatmap/model';

const monthName = (date: Date) => String(date.getUTCMonth() + 1);

describe('user reads the activity calendar', () => {
    it('user round-trips a calendar day without timezone drift', () => {
        expect(toIso(toUtc('2026-03-01'))).toBe('2026-03-01');
    });

    it('user rejects malformed input', () => {
        expect(Number.isNaN(toUtc('nope'))).toBe(true);
    });
});

describe('user reads the activity heatmap', () => {
    it('user lays days out as weeks of seven rows', () => {
        const days = [
            { date: '2026-01-01', count: 1 },
            { date: '2026-01-07', count: 2 },
        ];
        const model = buildModel(days, 1, undefined, monthName);

        expect(model.length).toBe(7);
        expect(gridSize(model)).toEqual({ columns: model.weeks, rows: 7 });
        // 2026-01-01 是周四，周一起算时前面空 3 格
        expect(model.lead).toBe(3);
        expect(slotOf(model, 0)).toEqual({ column: 0, row: 3 });
    });

    it('user counts missing days inside the range as zero', () => {
        const model = buildModel(
            [
                { date: '2026-01-01', count: 4 },
                { date: '2026-01-04', count: 8 },
            ],
            1,
            undefined,
            monthName
        );

        expect(model.counts).toEqual([4, 0, 0, 8]);
    });

    it('user buckets values into five levels with quarter thresholds by default', () => {
        // 最忙一天 100 → 阈值 25/50/75
        const model = buildModel(
            [
                { date: '2026-01-01', count: 0 },
                { date: '2026-01-02', count: 10 },
                { date: '2026-01-03', count: 30 },
                { date: '2026-01-04', count: 60 },
                { date: '2026-01-05', count: 100 },
            ],
            1,
            undefined,
            monthName
        );

        expect(model.thresholds).toEqual([25, 50, 75]);
        expect(model.levels).toEqual([0, 1, 2, 3, 4]);
    });

    it('user counts how many days sit at each level', () => {
        const model = buildModel(
            [
                { date: '2026-01-01', count: 0 },
                { date: '2026-01-02', count: 1 },
                { date: '2026-01-03', count: 1 },
            ],
            1,
            undefined,
            monthName
        );

        expect(model.perLevel[0]).toBe(1);
        expect(model.perLevel[1]).toBe(2);
        expect(model.total).toBe(2);
    });

    it('user labels each new month once, dropping a cramped first label', () => {
        const days = Array.from({ length: 120 }, (_, index) => {
            const date = new Date(Date.UTC(2026, 0, 1 + index));
            return { date: toIso(date.getTime()), count: 1 };
        });
        const model = buildModel(days, 1, undefined, monthName);

        const columns = model.months.map((month) => month.column);
        // 至少保留了后面几个月的标签，且相邻标签不挤在一起
        expect(columns.length).toBeGreaterThan(1);
        for (let index = 1; index < columns.length; index += 1) {
            expect(columns[index]! - columns[index - 1]!).toBeGreaterThanOrEqual(3);
        }
    });

    it('user handles no data without dividing by zero', () => {
        const model = buildModel([], 1, undefined, monthName);

        expect(model.length).toBe(0);
        expect(model.total).toBe(0);
        expect(model.thresholds.every((value) => value > 0)).toBe(true);
    });
});

describe('user moves through the heatmap with the keyboard', () => {
    const model = buildModel(
        Array.from({ length: 14 }, (_, index) => ({
            date: toIso(Date.UTC(2026, 0, 1 + index)),
            count: 1,
        })),
        1,
        undefined,
        monthName
    );

    it('user moves one day left and right', () => {
        expect(moveIndex(model, 5, 'ArrowLeft')).toBe(4);
        expect(moveIndex(model, 5, 'ArrowRight')).toBe(6);
    });

    it('user moves one week up and down', () => {
        expect(moveIndex(model, 8, 'ArrowUp')).toBe(1);
        expect(moveIndex(model, 8, 'ArrowDown')).toBe(13);
    });

    it('user clamps at the edges', () => {
        expect(moveIndex(model, 0, 'ArrowLeft')).toBe(0);
        expect(moveIndex(model, 13, 'ArrowRight')).toBe(13);
        expect(moveIndex(model, 3, 'ArrowUp')).toBe(0);
    });

    it('user jumps to the ends with Home and End', () => {
        expect(moveIndex(model, 7, 'Home')).toBe(0);
        expect(moveIndex(model, 7, 'End')).toBe(13);
    });
});
