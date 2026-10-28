import type { LogAttributeValue } from './types';

export const REDACTED = '[redacted]';

const REDACTED_EMAIL = '[redacted-email]';
const MAX_ATTRIBUTE_LENGTH = 1024;
const TRUNCATION_MARKER = '…';
/**
 * scheme 和邮箱的本地部分都写成有界量词。
 *
 * 无界写法会在每个词边界重扫剩余文本：`a-a-a-…` 这类输入上 URL 与邮箱正则
 * 都是 O(n²)，128KB 就能占住渲染线程几十秒。
 */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+/gi;
export const MAX_AUDIT_PAYLOAD_BYTES = 64 * 1024;
/**
 * 脱敏阶段最多扫描的字节数：审计载荷上限的两倍。
 *
 * 两倍足够填满 64KB 结果，同时让最坏情况的扫描成本有上界。
 */
const MAX_REDACTION_INPUT_BYTES = MAX_AUDIT_PAYLOAD_BYTES * 2;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi;
/** 没有 `Authorization:` 前缀的 Basic/Digest 凭据同样不能落盘。 */
const BASIC_CREDENTIAL_PATTERN = /\b(Basic|Digest)\s+[A-Za-z0-9+/=._~-]{8,}/gi;
/**
 * 键名先按普通标识符匹配，再交给 `isSecretKey` 判定。
 *
 * 旧写法把密钥词表和重复分组写进正则，`a-a-a-…` 这类输入会触发灾难性回溯：
 * 32KB 要 1.3s，128KB 要 19s，足够卡死渲染线程。现在键名是有界字符类，
 * 匹配与判定都是线性的。
 */
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
    `(["']?)([A-Za-z0-9_.-]{1,64})\\1(\\s*[=:]\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;}]+)`,
    'gi'
);
const SENSITIVE_HEADER_PATTERN = new RegExp(
    `(["']?)\\b(authorization|proxy-authorization)\\1(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\r\\n,;}]+)`,
    'gi'
);
/**
 * Cookie 的每一段都可能独立携带会话凭据，且段与段之间用 `;` 分隔。
 * 未加引号时吞掉整行，避免 `Cookie: session=x; csrftoken=y` 的尾部残留。
 */
const SENSITIVE_COOKIE_PATTERN = new RegExp(
    `(["']?)\\b((?:set-)?cookie)\\1(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\r\\n]+)`,
    'gi'
);
const COMMON_SECRET_TOKEN_PATTERN =
    /\b(?:sk|pk|ghp|gho|ghu|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g;
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
    'auth',
]);

/**
 * Split camelCase before matching, so `accessToken` and `privateKey` are treated like
 * `access_token` and `private_key`. A plain lowercase split missed them entirely.
 */
function keyParts(key: string): string[] {
    return key
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/** 字段名按分隔符拆词，避免 `monkey` 这类单词被误判为密钥。 */
export function isSecretKey(key: string): boolean {
    return keyParts(key).some((part) => SECRET_KEY_TOKENS.has(part));
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

/**
 * 去掉 URL 的 userinfo、query 和 hash。
 *
 * 解析失败时无法判断 `@` 前后哪一段是 userinfo，整段替换成固定标记，
 * 与 Rust 侧的 `redact_url` 保持一致。
 */
export function redactUrl(value: string): string {
    try {
        const url = new URL(value);
        if (!url.host) {
            return '[redacted-url]';
        }
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        const port = url.port ? `:${url.port}` : '';
        const path = url.pathname.length > 1 ? '/[redacted-path]' : '';
        return `${url.protocol}//${url.hostname}${port}${path}`;
    } catch {
        return '[redacted-url]';
    }
}

/** 按 UTF-8 字节截断，并预留标记本身的空间。 */
function truncateBytes(value: string, maxBytes: number): string {
    const encoded = new TextEncoder().encode(value);
    if (encoded.length <= maxBytes) {
        return value;
    }

    const budget = maxBytes - new TextEncoder().encode(TRUNCATION_MARKER).length;
    let used = 0;
    let end = 0;
    for (const character of value) {
        const size = new TextEncoder().encode(character).length;
        if (used + size > budget) {
            break;
        }
        used += size;
        end += character.length;
    }

    return `${value.slice(0, end)}${TRUNCATION_MARKER}`;
}

/** 自由文本里的 URL、邮箱、令牌、凭据赋值和主目录路径都脱敏。 */
export function redactText(value: string, maxLength = MAX_ATTRIBUTE_LENGTH): string {
    // 正则只扫描有界文本：超长工具输出不应该在脱敏阶段阻塞渲染线程。
    const scanBudget = Math.min(maxLength + 512, MAX_REDACTION_INPUT_BYTES);
    const redacted = truncateBytes(value, scanBudget)
        .replace(HOME_PATTERN, '~')
        .replace(URL_PATTERN, (match) => redactUrl(match))
        .replace(EMAIL_PATTERN, REDACTED_EMAIL)
        .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
        .replace(BASIC_CREDENTIAL_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`)
        .replace(COMMON_SECRET_TOKEN_PATTERN, REDACTED)
        .replace(
            SENSITIVE_HEADER_PATTERN,
            (_match, quote: string, key: string, separator: string) =>
                `${quote}${key}${quote}${separator}${REDACTED}`
        )
        .replace(
            SENSITIVE_COOKIE_PATTERN,
            (_match, quote: string, key: string, separator: string) =>
                `${quote}${key}${quote}${separator}${REDACTED}`
        )
        .replace(
            SECRET_ASSIGNMENT_PATTERN,
            (match, quote: string, key: string, separator: string, valueText: string) => {
                if (!isSecretKey(key)) return match;
                const replacement = valueText.startsWith('"')
                    ? `"${REDACTED}"`
                    : valueText.startsWith("'")
                      ? `'${REDACTED}'`
                      : REDACTED;
                return `${quote}${key}${quote}${separator}${replacement}`;
            }
        );

    return truncateBytes(redacted, maxLength);
}

function sanitizeAuditValue(value: unknown, depth = 0): unknown {
    if (depth > 8) return '[redacted-depth]';
    if (typeof value === 'string') return redactText(value, 8192);
    if (typeof value !== 'object' || value === null) return value;
    if (Array.isArray(value)) {
        const kept = value.slice(0, 100).map((entry) => sanitizeAuditValue(entry, depth + 1));
        if (value.length > 100) {
            kept.push(`[truncated ${value.length - 100} entries]`);
        }
        return kept;
    }

    const sanitized: Record<string, unknown> = {};
    const entries = Object.entries(value);
    for (const [key, entry] of entries.slice(0, 200)) {
        sanitized[key] = isSecretKey(key) ? REDACTED : sanitizeAuditValue(entry, depth + 1);
    }
    if (entries.length > 200) {
        sanitized._truncated_keys = entries.length - 200;
    }
    return sanitized;
}

function utf8Length(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

/** Serialize audit content with key-aware redaction and a hard 64KB ceiling. */
export function serializeAuditPayload(payload: unknown): string {
    if (typeof payload === 'string') {
        const originalBytes = utf8Length(payload);
        const redacted = redactText(payload, MAX_REDACTION_INPUT_BYTES);
        const encoded = new TextEncoder().encode(redacted);
        if (encoded.length <= MAX_AUDIT_PAYLOAD_BYTES) return redacted;

        const marker = `\n[truncated original_bytes=${originalBytes}]`;
        const preview = new TextDecoder().decode(
            encoded.slice(0, MAX_AUDIT_PAYLOAD_BYTES - utf8Length(marker))
        );
        return `${preview}${marker}`;
    }

    const serialized = JSON.stringify(sanitizeAuditValue(payload)) ?? 'null';
    const originalBytes = utf8Length(serialized);
    if (originalBytes <= MAX_AUDIT_PAYLOAD_BYTES) return serialized;

    const encoded = new TextEncoder().encode(serialized);
    // 预览比上限少 256 字节，给 `_truncated` 包装留出空间，保证结果不超限。
    const preview = new TextDecoder().decode(encoded.slice(0, MAX_AUDIT_PAYLOAD_BYTES - 256));
    return JSON.stringify({ _truncated: true, originalBytes, preview });
}
