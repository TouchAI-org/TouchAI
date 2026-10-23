// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { getLocale, t } from '@/i18n';

/**
 * Display rate for CNY.
 *
 * The pricing source (models.dev) quotes USD and the database stores USD
 * micros; nothing is rewritten on write. Conversion happens only for display
 * so a Chinese reader sees a familiar magnitude. The rate is fixed rather than
 * live, so the UI labels the figure as an estimate.
 */
export const USD_TO_CNY = 7.2;

function activeCurrency(): string {
    return getLocale() === 'zh-CN' ? 'CNY' : 'USD';
}

function convertMicros(micros: number): number {
    const usd = micros / 1_000_000;
    return getLocale() === 'zh-CN' ? usd * USD_TO_CNY : usd;
}

/**
 * Currency for display, converted from USD micros.
 *
 * `narrowSymbol` renders `¥1.70` instead of `CN¥1.70`; the currency is already
 * named by the surrounding label, so the country prefix is noise.
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

/** Compact currency for axes and cards. */
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
 * A value split into number, affixes, and decimals for the counter component.
 * The unit has to come out of the formatted string because only the digits animate.
 */
export interface CounterSpec {
    value: number;
    prefix?: string;
    suffix?: string;
    decimals?: number;
}

/** Currency counter: symbol as prefix, fixed two decimals. */
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

/** Integer counter. */
export function intCounter(value: number): CounterSpec {
    return { value, decimals: 0 };
}

/**
 * Compact token count, localised per language.
 *
 * Chinese reads 万 / 亿 and English reads K / M / B; forcing K/M into Chinese
 * gives `4.4M` in the middle of Chinese copy, and 亿 in English is just as odd.
 */
export function formatTokensCompact(value: number): string {
    const parts = tokensParts(value);
    return `${parts.value}${parts.unit}`;
}

/**
 * Compact token count split into number and unit.
 *
 * `formatTokensCompact` returns a joined string, but cards need the unit on its
 * own to dim it, so both go through this function and share one set of thresholds.
 */
export function tokensParts(tokens: number): { value: string; unit: string } {
    const locale = getLocale();

    if (locale === 'zh-CN') {
        if (tokens >= 100_000_000) return { value: trimZero(tokens / 100_000_000), unit: '亿' };
        if (tokens >= 10_000) return { value: trimZero(tokens / 10_000), unit: '万' };
        if (tokens >= 1_000) return { value: trimZero(tokens / 1_000), unit: '千' };
        return { value: formatInt(tokens), unit: '' };
    }

    if (tokens >= 1_000_000_000) return { value: trimZero(tokens / 1_000_000_000), unit: 'B' };
    if (tokens >= 1_000_000) return { value: trimZero(tokens / 1_000_000), unit: 'M' };
    if (tokens >= 1_000) return { value: trimZero(tokens / 1_000), unit: 'K' };
    return { value: formatInt(tokens), unit: '' };
}

/** Drop a trailing `.0`: `1万` reads better than `1.0万`. */
function trimZero(value: number): string {
    const fixed = value.toFixed(1);
    return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/** Integer with group separators. */
export function formatInt(value: number): string {
    return new Intl.NumberFormat(getLocale()).format(value);
}

/** Percentage with one decimal; tiny non-zero shares stay visible. */
export function formatPercent(ratio: number): string {
    if (ratio > 0 && ratio < 0.001) {
        return '<0.1%';
    }
    return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Long durations, for totals and segments.
 *
 * `formatDuration` suits millisecond-to-second values such as first-token
 * latency, but a total of several hundred seconds reads poorly as `2208.9s`
 * and hides the magnitude.
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

/** Millisecond duration: `850ms` / `3.2s`. */
export function formatDuration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined) {
        return '—';
    }
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Active duration split into number and unit pairs, so a card can dim the unit
 * and let the value carry the line.
 */
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

/** Decode speed in tok/s; null when there is no usable sample. */
export function formatSpeed(tokensPerSecond: number | null): string | null {
    if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) {
        return null;
    }
    return `${tokensPerSecond.toFixed(1)} tok/s`;
}

/** Database timestamp (UTC) rendered in local time. */
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

/** Heatmap day label: `YYYY-MM-DD` to `M/D`. */
export function formatDayLabel(day: string): string {
    const [, month, date] = day.split('-');
    return `${Number(month)}/${Number(date)}`;
}
