import type { DesktopModelLanguage } from './input';

export const MODEL_LANGUAGE_LABELS = {
    'zh-CN': 'Simplified Chinese (zh-CN)',
    'en-US': 'English (en-US)',
} as const;

const TOOL_LANGUAGE_CONTEXT_SENTENCE =
    'Use this language for user-facing tool arguments or generated content unless the user explicitly asks otherwise.';
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TOOL_LANGUAGE_CONTEXT_PATTERN = new RegExp(
    `\\s*Current TouchAI UI language: (${Object.values(MODEL_LANGUAGE_LABELS).map(escapeRegExp).join('|')})\\. ${escapeRegExp(TOOL_LANGUAGE_CONTEXT_SENTENCE)}`,
    'g'
);

export function modelSystemLanguage(context: DesktopModelLanguage): string {
    return [
        `Current TouchAI UI language: ${context.label}.`,
        'Use this language for user-facing replies by default unless the user explicitly asks for another language.',
    ].join('\n');
}

export function modelToolLanguage(context: DesktopModelLanguage): string {
    return [`Current TouchAI UI language: ${context.label}.`, TOOL_LANGUAGE_CONTEXT_SENTENCE].join(
        ' '
    );
}

export function appendModelToolLanguage(
    description: string,
    context: DesktopModelLanguage
): string {
    return [
        description.replace(TOOL_LANGUAGE_CONTEXT_PATTERN, '').trim(),
        modelToolLanguage(context),
    ]
        .filter(Boolean)
        .join('\n\n');
}
