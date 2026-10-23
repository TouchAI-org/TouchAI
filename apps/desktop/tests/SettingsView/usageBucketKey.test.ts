import { describe, expect, it } from 'vitest';

import { bucketKindOf, resolveUsageBucketMs } from '@/database/queries/usageStats';
import {
    localUsageKey,
    parseUsageTime,
} from '@/views/SettingsView/components/Usage/utils/usageOverlay';

/**
 * The query layer and the curve must agree on bucket keys.
 *
 * The SQL side computes an integer bucket index from Unix seconds and formats
 * it as UTC text; the UI has to produce the same text for the same instant,
 * otherwise every point falls outside the window and the curve renders flat.
 * These assertions pin the contract without depending on the machine timezone.
 */
describe('bucket key contract', () => {
    const bucketMs = 30 * 60_000;

    it('produces the same key the query layer formats', () => {
        const instant = new Date(Date.UTC(2026, 4, 1, 10, 45, 0));
        const key = localUsageKey(instant, bucketKindOf(bucketMs), bucketMs);

        expect(key).toBe('2026-05-01 10:30');
    });

    it('round-trips through parseUsageTime to the bucket start', () => {
        const instant = new Date(Date.UTC(2026, 4, 1, 10, 45, 0));
        const key = localUsageKey(instant, bucketKindOf(bucketMs), bucketMs);
        const at = parseUsageTime(key);

        expect(at).toBe(Date.UTC(2026, 4, 1, 10, 30, 0));
    });

    it('aligns every timestamp inside one bucket to the same key', () => {
        const kind = bucketKindOf(bucketMs);
        const keys = [0, 5, 17, 29].map((minute) =>
            localUsageKey(new Date(Date.UTC(2026, 4, 1, 10, minute, 0)), kind, bucketMs)
        );

        expect(new Set(keys).size).toBe(1);
    });

    it('separates adjacent buckets', () => {
        const kind = bucketKindOf(bucketMs);
        const first = localUsageKey(new Date(Date.UTC(2026, 4, 1, 10, 29, 0)), kind, bucketMs);
        const next = localUsageKey(new Date(Date.UTC(2026, 4, 1, 10, 31, 0)), kind, bucketMs);

        expect(first).not.toBe(next);
    });

    it('formats day buckets without a time part', () => {
        const day = resolveUsageBucketMs(30 * 86_400_000);
        expect(day).toBe(86_400_000);

        const key = localUsageKey(new Date(Date.UTC(2026, 4, 1, 10, 45, 0)), 'day', day);
        expect(key).toBe('2026-05-01');
    });
});
