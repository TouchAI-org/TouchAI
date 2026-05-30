export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = 'zh-CN';
export const FALLBACK_FIRST_LAUNCH_LOCALE: AppLocale = 'en-US';

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

export interface FirstLaunchLocaleSource {
    language?: string | null;
    languages?: readonly string[] | null;
}

export function resolveFirstLaunchLocale(source?: FirstLaunchLocaleSource): AppLocale {
    const localeSource = source ?? (typeof navigator === 'undefined' ? undefined : navigator);
    const primaryCandidate = [...(localeSource?.languages ?? []), localeSource?.language].find(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0
    );

    return primaryCandidate?.toLowerCase().startsWith('zh')
        ? 'zh-CN'
        : FALLBACK_FIRST_LAUNCH_LOCALE;
}
