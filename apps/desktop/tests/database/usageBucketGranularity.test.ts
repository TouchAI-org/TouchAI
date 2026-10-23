import { describe, expect, it } from 'vitest';

import {
    bucketKindOf,
    resolveUsageBucketMs,
    USAGE_TARGET_BUCKETS,
} from '@/database/queries/usageStats';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('when the usage chart picks a time bucket width', () => {
    it('user gets fine buckets when looking at a short range', () => {
        // One hour targets 48 buckets, about 75 seconds each, so the 2-minute step wins.
        expect(resolveUsageBucketMs(HOUR)).toBe(2 * MINUTE);
        // Six hours gives about 7.5 minutes per bucket, so 10 minutes.
        expect(resolveUsageBucketMs(6 * HOUR)).toBe(10 * MINUTE);
    });

    it('user gets coarser buckets as the range grows', () => {
        // One day gives about 30 minutes.
        expect(resolveUsageBucketMs(DAY)).toBe(30 * MINUTE);
        // A week gives about 3.5 hours, so 6 hours.
        expect(resolveUsageBucketMs(7 * DAY)).toBe(6 * HOUR);
        // A month gives about 15 hours, so 1 day.
        expect(resolveUsageBucketMs(30 * DAY)).toBe(DAY);
    });

    it('user gets a readable number of points for every range', () => {
        for (const span of [HOUR, 3 * HOUR, DAY, 7 * DAY, 30 * DAY]) {
            const bucketMs = resolveUsageBucketMs(span);
            const count = span / bucketMs;
            // One step of slack is fine; a handful of buckets or hundreds is not.
            expect(count).toBeGreaterThan(USAGE_TARGET_BUCKETS / 4);
            expect(count).toBeLessThan(USAGE_TARGET_BUCKETS * 2);
        }
    });

    it('user gets day buckets, not finer ones, for a whole year', () => {
        // Longer ranges cap at one day; coarser loses the point of a curve.
        expect(resolveUsageBucketMs(365 * DAY)).toBe(DAY);
        expect(resolveUsageBucketMs(3650 * DAY)).toBe(DAY);
    });

    it('user never gets a zero or negative bucket width', () => {
        expect(resolveUsageBucketMs(0)).toBeGreaterThan(0);
        expect(resolveUsageBucketMs(-1)).toBeGreaterThan(0);
    });
});

describe('when the usage chart labels its buckets', () => {
    it('user gets the right alignment for minute, hour and day buckets', () => {
        expect(bucketKindOf(MINUTE)).toBe('minute');
        expect(bucketKindOf(6 * HOUR)).toBe('hour');
        expect(bucketKindOf(DAY)).toBe('day');
    });
});
