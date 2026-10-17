// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { getLocale } from '@/i18n';

/** 金额：微元 → 本地化货币字符串 */
export function formatCost(micros: number, currency = 'CNY'): string {
    const amount = micros / 1_000_000;
    return new Intl.NumberFormat(getLocale(), {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
    }).format(amount);
}

/** 紧凑 token 数：1.2K / 3.4M */
export function formatTokensCompact(value: number): string {
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (value >= 1000) {
        return `${(value / 1000).toFixed(1)}K`;
    }
    return String(value);
}

/** 整数带千分位 */
export function formatInt(value: number): string {
    return new Intl.NumberFormat(getLocale()).format(value);
}

/** 百分比，保留一位小数 */
export function formatPercent(ratio: number): string {
    return `${(ratio * 100).toFixed(1)}%`;
}

/** 毫秒耗时：850ms / 3.2s */
export function formatDuration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined) {
        return '—';
    }
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    return `${(ms / 1000).toFixed(1)}s`;
}

/** 解码速度 tok/s，样本不足返回 null */
export function formatSpeed(tokensPerSecond: number | null): string | null {
    if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) {
        return null;
    }
    return `${tokensPerSecond.toFixed(1)} tok/s`;
}

/** 数据库时间戳（UTC）转本地时间显示 */
export function formatDbTime(value: string): string {
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const date = new Date(`${normalized}Z`);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return new Intl.DateTimeFormat(getLocale(), {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(date);
}

/** 热力图的日期标签（YYYY-MM-DD → M/D） */
export function formatDayLabel(day: string): string {
    const [, month, date] = day.split('-');
    return `${Number(month)}/${Number(date)}`;
}
