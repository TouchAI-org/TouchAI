import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { formatDateTime, formatMonthDay, formatShortDate, formatTime } from '@/i18n/format';

describe('i18n format helpers', () => {
    it('formats dates with the active locale by default', () => {
        const date = new Date('2026-05-20T08:09:10');

        setLocale('en-US');
        expect(formatShortDate(date)).toMatch(/May|5/);
        expect(formatDateTime(date)).toMatch(/2026|May|5/);
        expect(formatMonthDay(date)).toMatch(/May|5/);
        expect(formatTime(date)).not.toBe('');

        setLocale('zh-CN');
        expect(formatShortDate(date)).toContain('2026');
        expect(formatDateTime(date)).toContain('2026');
    });

    it('accepts string timestamps and handles invalid input consistently', () => {
        setLocale('en-US');

        expect(formatShortDate('2026-05-20T08:09:10')).not.toBe('');
        expect(formatDateTime('')).toBe('');
        expect(formatDateTime(null)).toBe('');
        expect(formatMonthDay(undefined)).toBe('');
        expect(formatTime('not-a-date')).toBe('');
        expect(formatShortDate('not-a-date')).toBe('');
    });

    it('uses an explicit locale without changing the active locale', () => {
        const date = new Date('2026-05-20T08:09:10');

        setLocale('zh-CN');

        expect(formatShortDate(date, 'en-US')).toMatch(/May|5/);
        expect(formatDateTime(date, 'en-US')).toMatch(/May|5/);
        expect(formatMonthDay(date, 'en-US')).toMatch(/May|5/);
        expect(formatTime(date, 'en-US')).not.toBe('');
    });
});
