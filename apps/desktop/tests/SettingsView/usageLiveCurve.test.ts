import { describe, expect, it } from 'vitest';

import {
    buildLiveCurve,
    LIVE_WINDOW_MS,
} from '@/views/SettingsView/components/Usage/utils/usageOverlay';

/**
 * The live curve must not vanish while a tool call runs.
 *
 * Recording a sample only when the cumulative total changed left the tool-call
 * stretch with no points at all, so the plot went blank.
 */
describe('user watches a live answer', () => {
    const now = Date.parse('2026-05-01T10:30:00Z');

    it('user keeps drawing a flat line while the rate is zero', () => {
        const samples = Array.from({ length: 40 }, (_, index) => ({
            atMs: now - 8000 + index * 200,
            tokens: 500,
            speed: 0,
        }));

        const curve = buildLiveCurve(samples, LIVE_WINDOW_MS, now);

        expect(curve.length).toBeGreaterThan(10);
        expect(curve.every((point) => point.value === 0)).toBe(true);
    });

    it('user sees a dip and recovery across a tool call', () => {
        const samples = [
            { atMs: now - 6000, tokens: 100, speed: 40 },
            { atMs: now - 5000, tokens: 140, speed: 40 },
            // Tool executes: rate drops to zero.
            { atMs: now - 4000, tokens: 140, speed: 0 },
            { atMs: now - 3000, tokens: 140, speed: 0 },
            // Tool returns and output resumes.
            { atMs: now - 2000, tokens: 200, speed: 60 },
            { atMs: now - 1000, tokens: 260, speed: 60 },
        ];

        const curve = buildLiveCurve(samples, LIVE_WINDOW_MS, now);
        const values = curve.map((point) => point.value);

        expect(values.some((value) => value > 0)).toBe(true);
        expect(values.some((value) => value === 0)).toBe(true);
        // A single point cannot be drawn as a line.
        expect(curve.length).toBeGreaterThan(3);
    });

    it('user keeps samples that arrive at the very edge of the window', () => {
        const samples = [
            { atMs: now - LIVE_WINDOW_MS + 10, tokens: 10, speed: 12 },
            { atMs: now - 1000, tokens: 90, speed: 30 },
        ];

        const curve = buildLiveCurve(samples, LIVE_WINDOW_MS, now);

        expect(curve.length).toBeGreaterThanOrEqual(2);
        expect(curve[0]!.at).toBeGreaterThanOrEqual(now - LIVE_WINDOW_MS);
    });
});
