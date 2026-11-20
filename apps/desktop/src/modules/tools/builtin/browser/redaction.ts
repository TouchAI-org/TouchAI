const REDACTED = '[redacted]';
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const CODE_LIKE_RE = /\b(?:[a-f0-9]{24,}|[A-Z0-9]{32,}|\d{6,8})\b/gi;
const SECRET_ASSIGNMENT_RE =
    /\b(token|password|passwd|secret|api[_-]?key|authorization|bearer|otp|code)=([^\s&]+)/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCredentialKey(key: string): boolean {
    return /(password|passwd|secret|token|api[_-]?key|authorization|credential|cookie|otp|code)/i.test(
        key
    );
}

function hasCredentialFieldHint(value: Record<string, unknown>): boolean {
    return ['field', 'name', 'label', 'placeholder', 'ref', 'selector', 'type'].some((key) => {
        const candidate = value[key];
        return typeof candidate === 'string' && isCredentialKey(candidate);
    });
}

export function redactUrl(value: string): string {
    try {
        const parsed = new URL(value);
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return value.replace(URL_RE, (match) => {
            try {
                const parsed = new URL(match);
                parsed.username = '';
                parsed.password = '';
                parsed.search = '';
                parsed.hash = '';
                return parsed.toString();
            } catch {
                return match;
            }
        });
    }
}

export function redactBrowserText(value: string): string {
    return value
        .replace(URL_RE, (match) => redactUrl(match))
        .replace(EMAIL_RE, '[redacted-email]')
        .replace(SECRET_ASSIGNMENT_RE, (_match, key) => `${key}=${REDACTED}`)
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, `Bearer ${REDACTED}`)
        .replace(CODE_LIKE_RE, REDACTED);
}

export function redactBrowserValue(value: unknown, keyHint = ''): unknown {
    if (typeof value === 'string') {
        if (isCredentialKey(keyHint)) {
            return REDACTED;
        }

        const redactedUrl = /(^|url|href)$/i.test(keyHint) ? redactUrl(value) : value;
        return redactBrowserText(redactedUrl);
    }

    if (Array.isArray(value)) {
        return value.map((item) => redactBrowserValue(item, keyHint));
    }

    if (isRecord(value)) {
        const credentialField = hasCredentialFieldHint(value);
        const output: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            if (
                key === 'base64' ||
                key === 'dataUrl' ||
                key === 'data_url' ||
                key === 'screenshotBase64' ||
                key === 'screenshot_base64'
            ) {
                output[key] = '[suppressed]';
                continue;
            }

            if ((key === 'value' || key === 'text') && credentialField) {
                output[key] = REDACTED;
                continue;
            }

            output[key] = redactBrowserValue(entry, key);
        }
        return output;
    }

    return value;
}

export function formatRedactedJson(value: unknown): string {
    return JSON.stringify(redactBrowserValue(value), null, 2);
}

export function redactCredentialFieldValue(field: string | undefined, value: unknown): unknown {
    if (!field || !isCredentialKey(field)) {
        return redactBrowserValue(value);
    }

    return REDACTED;
}
