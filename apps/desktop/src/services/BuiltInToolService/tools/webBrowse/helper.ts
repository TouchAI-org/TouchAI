// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { t, tt } from '@/i18n';

import { parseToolArguments } from '../../utils/toolSchema';
import {
    DEFAULT_MAX_CHARS,
    DEFAULT_TIMEOUT_MS,
    WEB_BROWSE_TOOL_NAME,
    webBrowseArgsSchema,
    type WebBrowseCommand,
    type WebBrowseExtractMode,
    type WebBrowseScrollDirection,
} from './constants';

/**
 * 前端侧发送给 Rust 侧 WebViewSessionManager 的请求结构。
 */
export interface WebBrowseNativeRequest {
    command: string;
    url?: string;
    selector?: string;
    direction?: string;
    pixels?: number;
    mode?: string;
    maxChars?: number;
    script?: string;
    timeoutMs?: number;
}

/**
 * Rust 侧返回的 WebView 浏览响应。
 */
export interface WebBrowseNativeResponse {
    currentUrl: string;
    content: string;
    title?: string;
    truncated: boolean;
}

interface ParsedWebBrowseRequest {
    command: WebBrowseCommand;
    url?: string;
    selector?: string;
    direction?: WebBrowseScrollDirection;
    pixels?: number;
    mode?: WebBrowseExtractMode;
    maxChars?: number;
    script?: string;
    timeoutMs: number;
}

/**
 * 解析 WebBrowse 工具参数，并在发送到 Rust 侧前完成校验。
 */
export function parseWebBrowseRequest(args: Record<string, unknown>): ParsedWebBrowseRequest {
    const parsedArgs = parseToolArguments(WEB_BROWSE_TOOL_NAME, webBrowseArgsSchema, args);

    // open 命令必须提供 url。
    if (parsedArgs.command === 'open' && !parsedArgs.url) {
        throw new Error(t('builtInTools.webBrowse.error.missingUrl'));
    }

    // open 命令的 url 需要通过 SSRF 校验。
    if (parsedArgs.command === 'open' && parsedArgs.url) {
        validateUrl(parsedArgs.url);
    }

    // click / find 命令必须提供 selector。
    if (
        (parsedArgs.command === 'click' || parsedArgs.command === 'find') &&
        !parsedArgs.selector
    ) {
        throw new Error(t('builtInTools.webBrowse.error.missingSelector'));
    }

    // evaluate 命令必须提供 script。
    if (parsedArgs.command === 'evaluate' && !parsedArgs.script) {
        throw new Error(t('builtInTools.webBrowse.error.missingScript'));
    }

    return {
        command: parsedArgs.command as WebBrowseCommand,
        url: parsedArgs.url,
        selector: parsedArgs.selector,
        direction: parsedArgs.direction as WebBrowseScrollDirection | undefined,
        pixels: parsedArgs.pixels,
        mode: parsedArgs.mode as WebBrowseExtractMode | undefined,
        maxChars: parsedArgs.maxChars ?? DEFAULT_MAX_CHARS,
        script: parsedArgs.script,
        timeoutMs: parsedArgs.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
}

/**
 * 将解析后的请求转换为 Rust 侧可接受的 camelCase 请求体。
 */
export function toNativeRequest(parsed: ParsedWebBrowseRequest): WebBrowseNativeRequest {
    return {
        command: parsed.command,
        url: parsed.url,
        selector: parsed.selector,
        direction: parsed.direction,
        pixels: parsed.pixels,
        mode: parsed.mode,
        maxChars: parsed.maxChars,
        script: parsed.script,
        timeoutMs: parsed.timeoutMs,
    };
}

/**
 * 格式化 WebBrowse 工具结果，返回给模型的结构化文本。
 */
export function formatBrowseResult(
    command: WebBrowseCommand,
    request: ParsedWebBrowseRequest,
    response: WebBrowseNativeResponse
): string {
    const headerLines = [
        tt('网页浏览'),
        `${tt('命令')}: ${command}`,
        `${tt('当前 URL')}: ${response.currentUrl}`,
    ];

    if (response.title) {
        headerLines.push(`${tt('页面标题')}: ${response.title}`);
    }

    if (request.command === 'open') {
        headerLines.push(`${tt('请求 URL')}: ${request.url}`);
    }

    if (response.truncated) {
        headerLines.push(tt('内容已截断'));
    }

    return [...headerLines, '', response.content || tt('[无内容]')].join('\n');
}

/**
 * 格式化错误结果。
 */
export function formatBrowseError(
    command: WebBrowseCommand,
    request: ParsedWebBrowseRequest,
    errorMessage: string
): string {
    const lines = [tt('网页浏览失败'), `${tt('命令')}: ${command}`];

    if (request.url) {
        lines.push(`${tt('请求 URL')}: ${request.url}`);
    }

    lines.push(`${tt('原因')}: ${errorMessage}`);
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// SSRF 防护（复用 webFetch/helper.ts 的逻辑）
// ---------------------------------------------------------------------------

const BLOCKED_PROTOCOLS = new Set(['http:', 'https:']);

function validateUrl(rawUrl: string): void {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error(t('builtInTools.webBrowse.error.invalidUrl', { url: rawUrl }));
    }

    if (!BLOCKED_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(t('builtInTools.webBrowse.error.invalidUrl', { url: rawUrl }));
    }

    if (isDisallowedHostname(parsed.hostname)) {
        throw new Error(t('builtInTools.webBrowse.error.blockedHost'));
    }
}

function stripIpv6Brackets(hostname: string): string {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isPrivateIpv4(hostname: string): boolean {
    const octets = hostname.split('.').map((segment) => Number(segment));
    if (octets.length !== 4 || octets.some((segment) => !Number.isInteger(segment))) {
        return false;
    }

    const [first = 0, second = 0] = octets;
    if (octets.some((segment) => segment < 0 || segment > 255)) {
        return false;
    }

    return (
        first === 0 ||
        first === 10 ||
        first === 127 ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
    );
}

function ipv4FromMappedIpv6(hostname: string): string | null {
    const normalized = stripIpv6Brackets(hostname).toLowerCase();
    const dottedMatch = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
    if (dottedMatch) {
        return dottedMatch[1] ?? null;
    }

    const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
    if (!hexMatch) {
        return null;
    }

    const high = Number.parseInt(hexMatch[1]!, 16);
    const low = Number.parseInt(hexMatch[2]!, 16);
    return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join('.');
}

function isPrivateIpv6(hostname: string): boolean {
    const normalized = stripIpv6Brackets(hostname).toLowerCase();
    const mappedIpv4 = ipv4FromMappedIpv6(normalized);
    if (mappedIpv4) {
        return isPrivateIpv4(mappedIpv4);
    }

    return (
        normalized === '::1' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') ||
        normalized.startsWith('fea') ||
        normalized.startsWith('feb')
    );
}

function isDisallowedHostname(hostname: string): boolean {
    const normalized = stripIpv6Brackets(hostname).toLowerCase();

    if (
        normalized === 'localhost' ||
        normalized.endsWith('.localhost') ||
        normalized.endsWith('.local') ||
        normalized.endsWith('.localdomain')
    ) {
        return true;
    }

    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
        return isPrivateIpv4(normalized);
    }

    if (normalized.includes(':')) {
        return isPrivateIpv6(normalized);
    }

    return !normalized.includes('.');
}
