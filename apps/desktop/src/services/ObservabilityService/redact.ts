import type { LogAttributeValue } from './types';

export const REDACTED = '[redacted]';

const REDACTED_EMAIL = '[redacted-email]';
const MAX_ATTRIBUTE_LENGTH = 1024;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi;
const SECRET_ASSIGNMENT_PATTERN =
    /\b(api[_-]?key|access[_-]?key|token|secret|password|passwd|authorization)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const HOME_PATTERN = /(?:\/(?:Users|home)\/[^/\s"'<>]+|\/root\b|C:\\Users\\[^\\\s"'<>]+)/gi;

const SECRET_KEY_TOKENS = new Set([
    'authorization',
    'cookie',
    'password',
    'passwd',
    'secret',
    'token',
    'key',
    'apikey',
    'credential',
]);

/** 字段名按分隔符拆词，避免 `monkey` 这类单词被误判为密钥。 */
export function isSecretKey(key: string): boolean {
    return key
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .some((part) => SECRET_KEY_TOKENS.has(part));
}

/** 属性值进入队列前统一脱敏；密钥字段整体替换。 */
export function redactAttributes(
    attrs: Record<string, LogAttributeValue>
): Record<string, LogAttributeValue> {
    const redacted: Record<string, LogAttributeValue> = {};
    for (const [key, value] of Object.entries(attrs)) {
        redacted[key] = isSecretKey(key)
            ? REDACTED
            : typeof value === 'string'
              ? redactText(value)
              : value;
    }
    return redacted;
}

/** 去掉 URL 的 userinfo、query 和 hash。 */
export function redactUrl(value: string): string {
    try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        const withoutFragment = value.split('#')[0] ?? value;
        return withoutFragment.split('?')[0] ?? withoutFragment;
    }
}

/** 自由文本里的 URL、邮箱、令牌、凭据赋值和主目录路径都脱敏。 */
export function redactText(value: string): string {
    const redacted = value
        .replace(HOME_PATTERN, '~')
        .replace(URL_PATTERN, (match) => redactUrl(match))
        .replace(EMAIL_PATTERN, REDACTED_EMAIL)
        .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
        .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => {
            return `${key}${separator}${REDACTED}`;
        });

    return redacted.length > MAX_ATTRIBUTE_LENGTH
        ? `${redacted.slice(0, MAX_ATTRIBUTE_LENGTH)}…`
        : redacted;
}
