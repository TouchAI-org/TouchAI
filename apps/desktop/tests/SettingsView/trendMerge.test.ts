// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { UsageTrendPoint } from '@database/queries/usageStats';
import { describe, expect, it } from 'vitest';

import { mergeUsageTrendSources } from '@/views/SettingsView/components/Usage/utils/trendMerge';

function point(key: string, tokens: number): UsageTrendPoint {
    return {
        key,
        requests: 1,
        tokens,
        costMicros: tokens,
        segments: [
            { groupId: null, name: `model-${key}`, requests: 1, tokens, costMicros: tokens },
        ],
    };
}

describe('user reads the all-time usage trend', () => {
    it('user sees frozen baseline and new live usage added for the same day', () => {
        const merged = mergeUsageTrendSources(
            [point('2026-05-01', 8)],
            [point('2026-05-01', 42)],
            [point('2026-05-01', 50)]
        );

        expect(merged).toHaveLength(1);
        expect(merged[0]).toMatchObject({ key: '2026-05-01', requests: 2, tokens: 50 });
    });

    it('user keeps a legacy archived day that has no baseline or live detail', () => {
        const merged = mergeUsageTrendSources(
            [point('2026-05-02', 8)],
            [point('2026-05-01', 42)],
            [point('2026-05-01', 50), point('2026-05-03', 12)]
        );

        expect(merged.map((item) => item.key)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
        expect(merged.find((item) => item.key === '2026-05-03')?.tokens).toBe(12);
    });
});
