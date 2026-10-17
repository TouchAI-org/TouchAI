import { describe, expect, it } from 'vitest';

import { formatCompactDuration, parseMillisecondDurationLabel } from '@/utils/duration';

describe('formatCompactDuration', () => {
    it('formats durations with seconds as the minimum unit and days as the maximum unit', () => {
        const durationMs = (((10 * 24 + 20) * 60 + 30) * 60 + 20) * 1000;

        expect(
            formatCompactDuration(durationMs, {
                minimumUnit: 'second',
            })
        ).toBe('10d 20h 30m 20s');
        expect(
            formatCompactDuration(65_000, {
                minimumUnit: 'second',
            })
        ).toBe('1m 5s');
        expect(
            formatCompactDuration(3_665_000, {
                minimumUnit: 'second',
            })
        ).toBe('1h 1m 5s');
    });

    it('supports floor rounding for live elapsed timers and millisecond labels when requested', () => {
        expect(
            formatCompactDuration(1_999, {
                minimumUnit: 'second',
                rounding: 'floor',
            })
        ).toBe('1s');
        expect(formatCompactDuration(420)).toBe('420ms');
    });

    it('can clamp settled sub-second durations to one second', () => {
        expect(
            formatCompactDuration(900, {
                minimumUnit: 'second',
                clampToOneSecond: true,
            })
        ).toBe('1s');
    });
});

describe('parseMillisecondDurationLabel', () => {
    it('parses millisecond duration labels and rejects non-millisecond formats', () => {
        expect(parseMillisecondDurationLabel('900ms')).toBe(900);
        expect(parseMillisecondDurationLabel(' 1200ms ')).toBe(1200);
        expect(parseMillisecondDurationLabel('1m 2s')).toBeNull();
        expect(parseMillisecondDurationLabel(null)).toBeNull();
    });
});
