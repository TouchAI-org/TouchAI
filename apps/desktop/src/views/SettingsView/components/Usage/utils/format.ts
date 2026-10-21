// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { getLocale, t } from '@/i18n';

/**
 * 中文界面的金额换算汇率。
 *
 * 定价源（models.dev）只给美元，库里存的也是美元微元，这里不改库、不改写入，
 * 只在展示时按当前语言换汇：中文看人民币更直观。汇率是固定值而不是实时汇率，
 * 只是量级参考，因此文案里已经写明「基于官方价格估算」。
 */
export const USD_TO_CNY = 7.2;

/** 当前语言下应使用的币种 */
function activeCurrency(): string {
    return getLocale() === 'zh-CN' ? 'CNY' : 'USD';
}

/** 美元微元 → 当前语言下金额的数值 */
function convertMicros(micros: number): number {
    const usd = micros / 1_000_000;
    return getLocale() === 'zh-CN' ? usd * USD_TO_CNY : usd;
}

/**
 * 金额：微元 → 本地化货币字符串。
 *
 * 库里存的是美元微元（定价源只给美元）。展示时按语言选择币种：
 * 中文换汇成人民币，英文保持美元。
 *
 * `narrowSymbol` 让中文界面显示 `¥1.70` 而不是 `CN¥1.70`：
 * 币种已在标题里说明，再带国家前缀属于冗余。
 */
export function formatCost(micros: number, currency = activeCurrency()): string {
    return new Intl.NumberFormat(getLocale(), {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
    }).format(convertMicros(micros));
}

/** 金额（紧凑形式，用于图表轴与卡片） */
export function formatCostCompact(micros: number, currency = activeCurrency()): string {
    const amount = convertMicros(micros);
    if (getLocale() === 'zh-CN') {
        const symbol = new Intl.NumberFormat(getLocale(), {
            style: 'currency',
            currency,
            currencyDisplay: 'narrowSymbol',
        })
            .formatToParts(0)
            .find((part) => part.type === 'currency')?.value;
        if (amount >= 100_000_000) return `${symbol}${(amount / 100_000_000).toFixed(1)}亿`;
        if (amount >= 10_000) return `${symbol}${(amount / 10_000).toFixed(1)}万`;
        if (amount >= 1000) return `${symbol}${amount.toFixed(1)}k`;
    }
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
 * 把一个数值拆成「数字 + 前后缀 + 小数位」，交给数字滚轮渲染。
 *
 * 滚轮只能转数字，所以单位必须从字符串里分出来。
 */
export interface CounterSpec {
    value: number;
    prefix?: string;
    suffix?: string;
    decimals?: number;
}

/** 金额 → 滚轮参数（币种符号作前缀，固定两位小数） */
export function costCounter(micros: number): CounterSpec {
    const symbol = new Intl.NumberFormat(getLocale(), {
        style: 'currency',
        currency: activeCurrency(),
        currencyDisplay: 'narrowSymbol',
    })
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value;

    return { value: convertMicros(micros), prefix: symbol, decimals: 2 };
}

/** 紧凑 token → 滚轮参数（万/亿 或 K/M/B 作后缀） */
export function tokensCounter(tokens: number): CounterSpec {
    if (getLocale() === 'zh-CN') {
        if (tokens >= 100_000_000) {
            return { value: tokens / 100_000_000, suffix: '亿', decimals: 1 };
        }
        if (tokens >= 10_000) {
            return { value: tokens / 10_000, suffix: '万', decimals: 1 };
        }
        return { value: tokens, decimals: 0 };
    }

    if (tokens >= 1_000_000_000) {
        return { value: tokens / 1_000_000_000, suffix: 'B', decimals: 1 };
    }
    if (tokens >= 1_000_000) {
        return { value: tokens / 1_000_000, suffix: 'M', decimals: 1 };
    }
    if (tokens >= 1_000) {
        return { value: tokens / 1_000, suffix: 'K', decimals: 1 };
    }
    return { value: tokens, decimals: 0 };
}

/** 整数 → 滚轮参数 */
export function intCounter(value: number): CounterSpec {
    return { value, decimals: 0 };
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

/** 百分比，保留一位小数；极小但非零的占比不显示成 0.0% */
export function formatPercent(ratio: number): string {
    if (ratio > 0 && ratio < 0.001) {
        return '<0.1%';
    }
    return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * 较大时长：用于总量与分段展示。
 *
 * `formatDuration` 适合毫秒到秒级（首字延迟、单次工具），
 * 但总量动辄几百秒，写成 `2208.9s` 既难读也看不出量级。
 */
export function formatLongDuration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    const totalSeconds = Math.round(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const hourUnit = t('settings.usage.duration.hour');
    const minuteUnit = t('settings.usage.duration.minute');
    const secondUnit = t('settings.usage.duration.second');

    if (hours > 0) return `${hours}${hourUnit} ${minutes}${minuteUnit}`;
    if (minutes >= 10) return `${minutes}${minuteUnit}`;
    return `${minutes}${minuteUnit} ${seconds}${secondUnit}`;
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
