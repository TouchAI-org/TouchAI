import { describe, expect, it } from 'vitest';

import {
    compressRatio,
    formatAxisValue,
    liveAxis,
    niceStep,
} from '@/views/SettingsView/components/Usage/utils/liveAxis';

describe('compressRatio', () => {
    it('maps the axis max to the full height', () => {
        expect(compressRatio(200, 200)).toBeCloseTo(1, 6);
    });

    it('lifts small values far above their linear share', () => {
        // Linear would put 10/200 at 5% height; compressed it is about 22%, so it shows.
        const ratio = compressRatio(10, 200);
        expect(ratio).toBeGreaterThan(0.2);
        expect(ratio).toBeLessThan(0.25);
    });

    it('stays monotone so the reading order never inverts', () => {
        const ratios = [0, 1, 5, 20, 80, 200].map((value) => compressRatio(value, 200));
        for (let index = 1; index < ratios.length; index += 1) {
            expect(ratios[index]!).toBeGreaterThanOrEqual(ratios[index - 1]!);
        }
    });

    it('never exceeds the plot when a value is above the axis max', () => {
        expect(compressRatio(500, 200)).toBeGreaterThan(1);
    });

    it('treats negatives and a zero axis as zero height', () => {
        expect(compressRatio(-5, 200)).toBe(0);
        expect(compressRatio(10, 0)).toBe(0);
    });
});

describe('niceStep', () => {
    it('splits the peak into about three steps', () => {
        expect(niceStep(200)).toBe(100);
        expect(niceStep(90)).toBe(50);
        expect(niceStep(12)).toBe(5);
    });

    it('never returns zero', () => {
        expect(niceStep(0)).toBeGreaterThan(0);
    });
});

describe('liveAxis', () => {
    it('rounds the max up so the axis does not jitter frame to frame', () => {
        // 92 and 97 share one step, so the axis stays put.
        expect(liveAxis([92]).max).toBe(liveAxis([97]).max);
    });

    it('grows the axis when the data really grows', () => {
        expect(liveAxis([40]).max).toBeLessThan(liveAxis([400]).max);
    });

    it('keeps a floor so idle noise is not magnified', () => {
        expect(liveAxis([0.2]).max).toBe(10);
        expect(liveAxis([]).max).toBe(10);
    });

    it('labels ticks with true values while spacing them by the transform', () => {
        const axis = liveAxis([200]);

        expect(axis.ticks[0]).toEqual({ value: 0, ratio: 0 });
        expect(axis.ticks[axis.ticks.length - 1]!.value).toBe(axis.max);
        // Middle ticks are not evenly spaced by height.
        const middle = axis.ticks[1]!;
        expect(middle.ratio).toBeGreaterThan(middle.value / axis.max);
    });
});

describe('formatAxisValue', () => {
    it('prints integers plainly and keeps one decimal otherwise', () => {
        expect(formatAxisValue(200)).toBe('200');
        expect(formatAxisValue(2.5)).toBe('2.5');
        expect(formatAxisValue(0)).toBe('0');
    });
});
