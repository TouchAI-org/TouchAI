// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { type AppLocale, getLocale } from '@/i18n';

const MODEL_LANGUAGE_LABELS: Record<AppLocale, string> = {
    'zh-CN': 'Simplified Chinese (zh-CN)',
    'en-US': 'English (en-US)',
};

const TOOL_LANGUAGE_CONTEXT_SENTENCE =
    'Use this language for user-facing tool arguments or generated content unless the user explicitly asks otherwise.';

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TOOL_LANGUAGE_CONTEXT_PATTERN = new RegExp(
    `\\s*Current TouchAI UI language: (${Object.values(MODEL_LANGUAGE_LABELS)
        .map(escapeRegExp)
        .join('|')})\\. ${escapeRegExp(TOOL_LANGUAGE_CONTEXT_SENTENCE)}`,
    'g'
);

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
    return [
        `Current TouchAI UI language: ${context.label}.`,
        'Use this language for user-facing replies by default unless the user explicitly asks for another language.',
    ].join('\n');
}

export function buildCurrentLanguageToolDescriptionContext(
    context: ModelLanguageContext = getCurrentModelLanguageContext()
): string {
    return [`Current TouchAI UI language: ${context.label}.`, TOOL_LANGUAGE_CONTEXT_SENTENCE].join(
        ' '
    );
}

export function appendCurrentLanguageToolDescriptionContext(
    description: string,
    context: ModelLanguageContext = getCurrentModelLanguageContext()
): string {
    const normalizedDescription = description.replace(TOOL_LANGUAGE_CONTEXT_PATTERN, '').trim();
    return [normalizedDescription, buildCurrentLanguageToolDescriptionContext(context)]
        .filter(Boolean)
        .join('\n\n');
}
