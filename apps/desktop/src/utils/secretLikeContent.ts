// Copyright (c) 2026. 千诚. Licensed under GPL v3

export const REDACTED_SECRET_LIKE_CONTENT = '[REDACTED_SECRET_LIKE_CONTENT]';

const SECRET_LIKE_PATTERNS = [
    /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gi,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4096}/gi,
    /\bsk-[A-Za-z0-9_-]{8,}/gi,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g,
    /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    /\bxox(?:[abprs]|p-[0-9])-[0-9A-Za-z-]{20,}\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
    /\b[A-Z0-9_]*(?:API|ACCESS|SECRET|PRIVATE|TOKEN|KEY)[A-Z0-9_]*\s*=\s*\S+/gi,
    /\b(?:PASSWORD|PASSWD|PWD)\s*[:=]\s*\S+/gi,
];

export function containsSecretLikeContent(content: string): boolean {
    return SECRET_LIKE_PATTERNS.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(content);
    });
}

export function redactSecretLikeContent(content: string): string {
    return SECRET_LIKE_PATTERNS.reduce((redacted, pattern) => {
        pattern.lastIndex = 0;
        return redacted.replace(pattern, REDACTED_SECRET_LIKE_CONTENT);
    }, content);
}

function redactStringValuesDeep(
    value: unknown,
    redactString: (content: string) => string
): unknown {
    if (typeof value === 'string') {
        return redactString(value);
    }

    if (Array.isArray(value)) {
        return value.map((item) => redactStringValuesDeep(item, redactString));
    }

    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                redactStringValuesDeep(item, redactString),
            ])
        );
    }

    return value;
}

export function redactSecretLikeStringValues<T>(value: T): T {
    return redactStringValuesDeep(value, redactSecretLikeContent) as T;
}

export function redactAllStringValues<T>(value: T): T {
    return redactStringValuesDeep(value, () => REDACTED_SECRET_LIKE_CONTENT) as T;
}
