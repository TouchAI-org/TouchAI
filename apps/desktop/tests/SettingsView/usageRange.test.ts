// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { describe, expect, it } from 'vitest';

import {
    resolveUsageRange,
    toDbRangeString,
} from '../../src/views/SettingsView/components/Usage/utils/usageRange';

describe('toDbRangeString', () => {
    it('matches the database timestamp format written by datetime("now")', () => {
        const value = toDbRangeString(new Date('2026-03-04T05:06:07.891Z'));

        // `YYYY-MM-DD HH:MM:SS`, UTC, no milliseconds and no timezone suffix —
        // the same shape SQLite's datetime('now') produces.
        expect(value).toBe('2026-03-04 05:06:07');
    });

    it('stays comparable as a string against stored timestamps', () => {
        const earlier = toDbRangeString(new Date('2026-03-04T05:06:07Z'));
        const later = toDbRangeString(new Date('2026-03-04T05:06:08Z'));

        expect(earlier < later).toBe(true);
    });
});

describe('resolveUsageRange', () => {
    it('returns an open range for "all"', () => {
        const range = resolveUsageRange('all');

        expect(range.from).toBe('1970-01-01 00:00:00');
        expect(range.to).toBe('9999-12-31 23:59:59');
    });

    it('produces from <= to for every preset', () => {
        for (const preset of ['today', '24h', '7d', '30d', 'all', 'custom'] as const) {
            const range = resolveUsageRange(preset);
            expect(range.from <= range.to).toBe(true);
        }
    });

    it('keeps 24h narrower than 7d', () => {
        const day = resolveUsageRange('24h');
        const week = resolveUsageRange('7d');

        expect(week.from < day.from).toBe(true);
    });

    it('includes the whole current day for "today"', () => {
        const now = new Date();
        const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // 起点就是本地零点（转成数据库的 UTC 时间戳格式后比较）
        expect(resolveUsageRange('today').from).toBe(toDbRangeString(localMidnight));
    });

    it('ignores custom bounds when the preset is not custom', () => {
        const range = resolveUsageRange('7d', {
            from: '2020-01-01 00:00:00',
            to: '2020-01-02 00:00:00',
        });

        expect(range.from).not.toBe('2020-01-01 00:00:00');
    });

    it('falls back to a 7 day window when custom bounds are missing', () => {
        const range = resolveUsageRange('custom');
        const from = new Date(range.from.replace(' ', 'T') + 'Z');
        const to = new Date(range.to.replace(' ', 'T') + 'Z');

        // 不应塌缩成零宽区间
        expect(to.getTime() - from.getTime()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    });
});
