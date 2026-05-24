export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = 'zh-CN';

export const LOCALE_LABELS: Record<AppLocale, string> = {
    'zh-CN': '简体中文',
    'en-US': 'English',
};

export function isSupportedLocale(value: unknown): value is AppLocale {
    return typeof value === 'string' && SUPPORTED_LOCALES.includes(value as AppLocale);
}

export function normalizeLocale(value: unknown): AppLocale {
    return isSupportedLocale(value) ? value : DEFAULT_LOCALE;
}
