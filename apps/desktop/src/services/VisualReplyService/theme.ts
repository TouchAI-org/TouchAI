// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

const THEME_TOKENS = {
    '--touchai-color-text-primary': '--color-text-primary',
    '--touchai-color-text-secondary': '--color-text-secondary',
    '--touchai-color-text-tertiary': '--color-text-tertiary',
    '--touchai-color-border': '--color-border',
    '--touchai-color-border-subtle': '--color-border-subtle',
    '--touchai-color-surface-raised': '--color-surface-raised',
    '--touchai-color-primary': '--color-primary-700',
    '--touchai-color-success': '--color-success-800',
    '--touchai-color-warning': '--color-warning-800',
    '--touchai-color-danger': '--color-error-800',
    '--touchai-color-focus': '--color-focus',
    '--touchai-radius-control': '--radius-control',
    '--touchai-radius-card': '--radius-card',
    '--touchai-font-sans': '--font-sans',
    '--touchai-font-mono': '--font-mono',
} as const;

export const VISUAL_REPLY_THEME_CHANGE_EVENT = 'touchai-theme-change';

export type VisualReplyThemeSnapshot = Partial<Record<keyof typeof THEME_TOKENS, string>>;
export const VISUAL_REPLY_THEME_TOKEN_NAMES = Object.keys(THEME_TOKENS) as Array<
    keyof typeof THEME_TOKENS
>;

function isSafeThemeValue(value: string): boolean {
    return !/[;{}<>\n\r]|url\s*\(|expression\s*\(/i.test(value);
}

export function normalizeVisualReplyThemeSnapshot(value: unknown): VisualReplyThemeSnapshot {
    if (!value || typeof value !== 'object') return {};

    const source = value as Record<string, unknown>;
    const snapshot: VisualReplyThemeSnapshot = {};
    for (const token of VISUAL_REPLY_THEME_TOKEN_NAMES) {
        const candidate = source[token];
        if (typeof candidate === 'string' && candidate && isSafeThemeValue(candidate)) {
            snapshot[token] = candidate;
        }
    }

    return snapshot;
}

export function createVisualReplyThemeSnapshot(
    root: HTMLElement = document.documentElement
): VisualReplyThemeSnapshot {
    const computed = getComputedStyle(root);
    const snapshot: VisualReplyThemeSnapshot = {};

    for (const [targetToken, sourceToken] of Object.entries(THEME_TOKENS)) {
        const value = computed.getPropertyValue(sourceToken).trim();
        if (value && isSafeThemeValue(value)) {
            snapshot[targetToken as keyof typeof THEME_TOKENS] = value;
        }
    }

    return snapshot;
}

export function serializeVisualReplyTheme(snapshot: VisualReplyThemeSnapshot): string {
    const normalized = normalizeVisualReplyThemeSnapshot(snapshot);
    return VISUAL_REPLY_THEME_TOKEN_NAMES.map((token) => {
        const value = normalized[token];
        if (!value) return '';
        return `${token}:${value}`;
    })
        .filter(Boolean)
        .join(';');
}

export function dispatchVisualReplyThemeChange(): void {
    window.dispatchEvent(new Event(VISUAL_REPLY_THEME_CHANGE_EVENT));
}
