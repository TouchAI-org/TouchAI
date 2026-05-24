import { getLocale } from '.';
import type { AppLocale } from './locales';

type DateInput = Date | string | number | null | undefined;

function toDate(value: DateInput): Date | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function localeForFormatting(locale: AppLocale = getLocale()): string {
    return locale;
}

export function formatShortDate(value: DateInput, locale?: AppLocale): string {
    const date = toDate(value);
    if (!date) {
        return '';
    }

    return new Intl.DateTimeFormat(localeForFormatting(locale), {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    }).format(date);
}

export function formatDateTime(value: DateInput, locale?: AppLocale): string {
    const date = toDate(value);
    if (!date) {
        return '';
    }

    return new Intl.DateTimeFormat(localeForFormatting(locale), {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}

export function formatMonthDay(value: DateInput, locale?: AppLocale): string {
    const date = toDate(value);
    if (!date) {
        return '';
    }

    return new Intl.DateTimeFormat(localeForFormatting(locale), {
        month: 'short',
        day: 'numeric',
    }).format(date);
}

export function formatTime(value: DateInput, locale?: AppLocale): string {
    const date = toDate(value);
    if (!date) {
        return '';
    }

    return new Intl.DateTimeFormat(localeForFormatting(locale), {
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}
