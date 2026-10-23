import { describe, expect, it } from 'vitest';

import {
    bucketKindOf,
    resolveUsageBucketMs,
    USAGE_TARGET_BUCKETS,
} from '@/database/queries/usageStats';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('resolveUsageBucketMs', () => {
    it('uses fine buckets for short ranges', () => {
        // One hour targets 48 buckets, about 75 seconds each, so the 2-minute step wins.
        expect(resolveUsageBucketMs(HOUR)).toBe(2 * MINUTE);
        // Six hours gives about 7.5 minutes per bucket, so 10 minutes.
        expect(resolveUsageBucketMs(6 * HOUR)).toBe(10 * MINUTE);
    });

    it('uses coarser buckets as the range grows', () => {
        // One day gives about 30 minutes.
        expect(resolveUsageBucketMs(DAY)).toBe(30 * MINUTE);
        // A week gives about 3.5 hours, so 6 hours.
        expect(resolveUsageBucketMs(7 * DAY)).toBe(6 * HOUR);
        // A month gives about 15 hours, so 1 day.
        expect(resolveUsageBucketMs(30 * DAY)).toBe(DAY);
    });

    it('keeps the bucket count reasonable for every range', () => {
        for (const span of [HOUR, 3 * HOUR, DAY, 7 * DAY, 30 * DAY]) {
            const bucketMs = resolveUsageBucketMs(span);
            const count = span / bucketMs;
            // One step of slack is fine; a handful of buckets or hundreds is not.
            expect(count).toBeGreaterThan(USAGE_TARGET_BUCKETS / 4);
            expect(count).toBeLessThan(USAGE_TARGET_BUCKETS * 2);
        }
    });

    it('caps at one day so a year is drawn as 365 points', () => {
        // Longer ranges cap at one day; coarser loses the point of a curve.
        expect(resolveUsageBucketMs(365 * DAY)).toBe(DAY);
        expect(resolveUsageBucketMs(3650 * DAY)).toBe(DAY);
    });

    it('never returns a zero or negative width', () => {
        expect(resolveUsageBucketMs(0)).toBeGreaterThan(0);
        expect(resolveUsageBucketMs(-1)).toBeGreaterThan(0);
    });
});

describe('bucketKindOf', () => {
    it('maps widths to the alignment kind', () => {
        expect(bucketKindOf(MINUTE)).toBe('minute');
        expect(bucketKindOf(6 * HOUR)).toBe('hour');
        expect(bucketKindOf(DAY)).toBe('day');
    });
});
