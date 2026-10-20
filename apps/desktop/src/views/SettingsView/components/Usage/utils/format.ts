// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { getLocale, t } from '@/i18n';

/**
 * 金额：微元 → 本地化货币字符串。
 *
 * 默认 USD 是因为唯一的定价源（models.dev）以美元报价，
 * `computeCost` 也就把 `USD` 写进了每条调用记录。
 * 这里若默认 CNY，等于把 $3 的调用显示成 ¥3。
 *
 * `narrowSymbol` 让中文界面显示 `$1.70` 而不是 `US$1.70`：
 * 币种已在标题里说明，再带国家前缀属于冗余。
 */
export function formatCost(micros: number, currency = 'USD'): string {
    const amount = micros / 1_000_000;
    return new Intl.NumberFormat(getLocale(), {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
    }).format(amount);
}

/** 金额（紧凑形式，用于图表轴与卡片） */
export function formatCostCompact(micros: number, currency = 'USD'): string {
    const amount = micros / 1_000_000;
    if (amount >= 1000) {
        return new Intl.NumberFormat(getLocale(), {
            style: 'currency',
            currency,
            currencyDisplay: 'narrowSymbol',
            notation: 'compact',
            maximumFractionDigits: 1,
        }).format(amount);
    }

    return new Intl.NumberFormat(getLocale(), {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(amount);
}

/**
 * 紧凑 token 数：按语言选单位。
 *
 * 中文习惯看「万 / 亿」，英文习惯看 K / M / B。
 * 用同一套 K/M 会在中文界面里读成「4.4M」，与其余中文文案脱节；
 * 反之把「亿」塞给英文界面也一样别扭。所以按当前语言分两条分支。
 */
export function formatTokensCompact(value: number): string {
    const locale = getLocale();

    if (locale === 'zh-CN') {
        if (value >= 100_000_000) {
            return `${trimZero(value / 100_000_000)}亿`;
        }
        if (value >= 10_000) {
            return `${trimZero(value / 10_000)}万`;
        }
        return String(value);
    }

    if (value >= 1_000_000_000) {
        return `${trimZero(value / 1_000_000_000)}B`;
    }
    if (value >= 1_000_000) {
        return `${trimZero(value / 1_000_000)}M`;
    }
    if (value >= 1_000) {
        return `${trimZero(value / 1_000)}K`;
    }
    return String(value);
}

/** 保留一位小数，但去掉无意义的 `.0`（「1.0万」读起来不如「1万」） */
function trimZero(value: number): string {
    const fixed = value.toFixed(1);
    return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
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

/** 将累计活跃时长拆成数字与单位，便于卡片弱化单位、突出数值。 */
export function formatActiveDuration(
    ms: number | null | undefined
): Array<{ value: string; unit: string }> {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return [];

    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (totalSeconds === 0 && ms > 0) {
        return [{ value: '<1', unit: t('settings.usage.duration.second') }];
    }
    if (hours > 0) {
        return [
            { value: formatInt(hours), unit: t('settings.usage.duration.hour') },
            { value: formatInt(minutes), unit: t('settings.usage.duration.minute') },
        ];
    }
    if (minutes > 0) {
        return [
            { value: formatInt(minutes), unit: t('settings.usage.duration.minute') },
            { value: formatInt(seconds), unit: t('settings.usage.duration.second') },
        ];
    }
    return [{ value: formatInt(seconds), unit: t('settings.usage.duration.second') }];
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
