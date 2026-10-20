// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';

import {
    formatActiveDuration,
    formatCost,
    formatDayLabel,
    formatDbTime,
    formatDuration,
    formatLongDuration,
    formatPercent,
    formatSpeed,
    formatTokensCompact,
} from '../../src/views/SettingsView/components/Usage/utils/format';

describe('formatCost', () => {
    it('formats in USD by default, matching the pricing source', () => {
        setLocale('en-US');
        const text = formatCost(1_500_000);

        // models.dev 报价是美元；默认渲染成 CNY 会把 $1.50 显示成 ¥1.50
        expect(text).toContain('$');
        expect(text).not.toContain('¥');
    });

    it('formats micro units as currency units', () => {
        setLocale('en-US');
        expect(formatCost(1_000_000)).toContain('1.00');
    });

    it('renders zero as a currency amount rather than blank', () => {
        setLocale('en-US');
        expect(formatCost(0)).toContain('0.00');
    });
});

describe('formatTokensCompact', () => {
    it('keeps small counts verbatim', () => {
        expect(formatTokensCompact(42)).toBe('42');
    });

    it('compacts thousands, millions and billions', () => {
        expect(formatTokensCompact(1_500)).toBe('1.5K');
        expect(formatTokensCompact(2_400_000)).toBe('2.4M');
        expect(formatTokensCompact(3_900_000_000)).toBe('3.9B');
    });
});

describe('formatPercent', () => {
    it('keeps one decimal so small differences stay visible', () => {
        expect(formatPercent(0)).toBe('0.0%');
        expect(formatPercent(0.1234)).toBe('12.3%');
        expect(formatPercent(1)).toBe('100.0%');
    });
});

describe('formatDuration', () => {
    it('returns a dash for a missing sample instead of zero', () => {
        expect(formatDuration(null)).toBe('—');
        expect(formatDuration(undefined)).toBe('—');
    });

    it('switches to seconds past one second', () => {
        expect(formatDuration(850)).toBe('850ms');
        expect(formatDuration(3200)).toBe('3.2s');
    });
});

describe('formatActiveDuration', () => {
    it('keeps accumulated hours instead of wrapping them into days', () => {
        setLocale('zh-CN');
        expect(formatActiveDuration((188 * 60 + 7) * 60_000)).toEqual([
            { value: '188', unit: '小时' },
            { value: '7', unit: '分' },
        ]);
    });

    it('keeps short conversations visible in seconds', () => {
        setLocale('zh-CN');
        expect(formatActiveDuration(1)).toEqual([{ value: '<1', unit: '秒' }]);
        expect(formatActiveDuration(999)).toEqual([{ value: '<1', unit: '秒' }]);
        expect(formatActiveDuration(1000)).toEqual([{ value: '1', unit: '秒' }]);
        expect(formatActiveDuration(3000)).toEqual([{ value: '3', unit: '秒' }]);
        expect(formatActiveDuration(65_000)).toEqual([
            { value: '1', unit: '分' },
            { value: '5', unit: '秒' },
        ]);
        expect(formatActiveDuration(3_600_000)).toEqual([
            { value: '1', unit: '小时' },
            { value: '0', unit: '分' },
        ]);
    });

    it('distinguishes zero from a missing or invalid duration', () => {
        setLocale('zh-CN');
        expect(formatActiveDuration(0)).toEqual([{ value: '0', unit: '秒' }]);
        expect(formatActiveDuration(null)).toEqual([]);
        expect(formatActiveDuration(Number.NaN)).toEqual([]);
        expect(formatActiveDuration(-1)).toEqual([]);
    });

    it('localizes the duration units', () => {
        setLocale('en-US');
        expect(formatActiveDuration((188 * 60 + 7) * 60_000)).toEqual([
            { value: '188', unit: 'h' },
            { value: '7', unit: 'm' },
        ]);
    });
    it('keeps small non-zero shares readable instead of rounding them to zero', () => {
        expect(formatPercent(0.0004)).toBe('<0.1%');
        expect(formatPercent(0.001)).toBe('0.1%');
        expect(formatPercent(0)).toBe('0.0%');
    });
});

describe('formatLongDuration', () => {
    it('switches to minutes and hours once seconds stop being readable', () => {
        setLocale('zh-CN');
        expect(formatLongDuration(3_000)).toBe('3s');
        expect(formatLongDuration(71_500)).toBe('1分 12秒');
        expect(formatLongDuration(747_700)).toBe('12分');
        expect(formatLongDuration(2_208_900)).toBe('36分');
        expect(formatLongDuration(5_400_000)).toBe('1小时 30分');
    });

    it('returns a dash for a missing sample', () => {
        expect(formatLongDuration(null)).toBe('—');
        expect(formatLongDuration(Number.NaN)).toBe('—');
    });
});

describe('formatSpeed', () => {
    it('returns null when there is no usable sample', () => {
        expect(formatSpeed(null)).toBeNull();
        expect(formatSpeed(0)).toBeNull();
        expect(formatSpeed(Number.NaN)).toBeNull();
    });

    it('formats a positive rate', () => {
        expect(formatSpeed(12.34)).toBe('12.3 tok/s');
    });
});

describe('formatDbTime', () => {
    it('treats the stored value as UTC', () => {
        // 数据库写的是 datetime('now')，没有时区后缀，必须按 UTC 解析
        const text = formatDbTime('2026-05-01 00:00:00');
        expect(text).toMatch(/\d{2}:\d{2}/);
    });

    it('returns the input unchanged when it cannot be parsed', () => {
        expect(formatDbTime('not-a-date')).toBe('not-a-date');
    });
});

describe('formatDayLabel', () => {
    it('drops the year and leading zeros', () => {
        expect(formatDayLabel('2026-05-01')).toBe('5/1');
        expect(formatDayLabel('2026-12-25')).toBe('12/25');
    });
});
