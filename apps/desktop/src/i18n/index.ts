import type { App } from 'vue';
import { computed } from 'vue';
import { createI18n } from 'vue-i18n';

import {
    type AppLocale,
    DEFAULT_LOCALE,
    FALLBACK_FIRST_LAUNCH_LOCALE,
    isSupportedLocale,
    LOCALE_LABELS,
    normalizeLocale,
    resolveFirstLaunchLocale,
    SUPPORTED_LOCALES,
} from './locales';
import { type MessageKey, type MessageParams, messages } from './messages';
import { type SourceText, zhToEnTextMap } from './textMap';

function createRuntimeMessages(): typeof messages {
    return {
        'zh-CN': { ...messages['zh-CN'] },
        'en-US': { ...messages['en-US'] },
    };
}

export const i18n = createI18n({
    legacy: false,
    locale: DEFAULT_LOCALE,
    fallbackLocale: DEFAULT_LOCALE,
    globalInjection: true,
    flatJson: true,
    missingWarn: false,
    fallbackWarn: false,
    messages: createRuntimeMessages(),
});

const composer = i18n.global;

export function getLocale(): AppLocale {
    return normalizeLocale(composer.locale.value);
}

export function setLocale(locale: unknown): AppLocale {
    const normalizedLocale = normalizeLocale(locale);
    composer.locale.value = normalizedLocale;
    document.documentElement.lang = normalizedLocale;
    return normalizedLocale;
}

export function t(key: MessageKey, params?: MessageParams): string {
    return composer.t(key, params ?? {});
}

export function tp(key: MessageKey, count: number, params?: MessageParams): string {
    return composer.t(key, { ...(params ?? {}), count }, count);
}

function interpolateLegacyMessage(message: string, params?: MessageParams): string {
    if (!params) {
        return message;
    }

    return message.replace(/\{(\w+)\}/g, (match, key: string) => {
        const value = params[key];
        return value === undefined ? match : String(value);
    });
}

/**
 * Legacy source-text compatibility bridge for code that cannot use Vue's
 * setup-scoped `useI18n()` yet, such as services and persisted historical UI text.
 * New Vue components should prefer keyed vue-i18n messages through `t(...)`.
 */
export function tt(text: string, params?: MessageParams): string {
    const message =
        getLocale() === 'en-US' && Object.prototype.hasOwnProperty.call(zhToEnTextMap, text)
            ? zhToEnTextMap[text as SourceText]
            : text;
    return interpolateLegacyMessage(message, params);
}

export function installI18n(app: App): void {
    app.use(i18n);
    const globalProperties = app.config.globalProperties as Record<string, unknown>;
    globalProperties.$tt = tt;
}

export {
    type AppLocale,
    DEFAULT_LOCALE,
    FALLBACK_FIRST_LAUNCH_LOCALE,
    isSupportedLocale,
    LOCALE_LABELS,
    type MessageKey,
    type MessageParams,
    normalizeLocale,
    resolveFirstLaunchLocale,
    type SourceText,
    SUPPORTED_LOCALES,
};

export const locale = computed(() => getLocale());
