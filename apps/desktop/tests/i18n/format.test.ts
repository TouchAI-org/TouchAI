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
        expect(formatDateTime(null)).toBe('');
        expect(formatShortDate('not-a-date')).toBe('');
    });
});
