// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    appendModelToolLanguage,
    MODEL_LANGUAGE_LABELS,
    modelSystemLanguage,
    modelToolLanguage,
} from '@/adapters/models/language';
import { type AppLocale, getLocale } from '@/i18n/index';

export interface ModelLanguageContext {
    locale: AppLocale;
    label: string;
}

export function getCurrentModelLanguageContext(): ModelLanguageContext {
    const locale = getLocale();
    return {
        locale,
        label: MODEL_LANGUAGE_LABELS[locale],
    };
}

export function buildCurrentLanguageSystemPrompt(
    context: ModelLanguageContext = getCurrentModelLanguageContext()
): string {
    return modelSystemLanguage(context);
}

export function buildCurrentLanguageToolDescriptionContext(
    context: ModelLanguageContext = getCurrentModelLanguageContext()
): string {
    return modelToolLanguage(context);
}

export function appendCurrentLanguageToolDescriptionContext(
    description: string,
    context: ModelLanguageContext = getCurrentModelLanguageContext()
): string {
    return appendModelToolLanguage(description, context);
}
