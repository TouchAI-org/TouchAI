// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

import { normalizeOptionalString } from '@/utils/text';

import { parseToolArguments } from '../../utils/toolSchema';
import {
    DEFAULT_SOURCE_CHAR_LIMIT,
    DEFAULT_TIMEOUT_MS,
    SUPPORTED_PROTOCOLS,
    WEB_FETCH_TOOL_NAME,
    webFetchArgsSchema,
    type WebFetchMode,
} from './constants';

const turndownService = createTurndownService();

interface WebFetchRequest {
    url: URL;
    mode: WebFetchMode;
    maxChars: number;
    timeoutMs: number;
}

interface ResponseTextPayload {
    text: string;
    sourceTruncated: boolean;
}

interface WebFetchMetadata {
    title?: string;
    byline?: string;
    siteName?: string;
    excerpt?: string;
    publishedTime?: string;
}

interface FormattedFetchPayload extends WebFetchMetadata {
    content: string;
    actualMode: WebFetchMode;
    bodyTruncated: boolean;
    sourceTruncated: boolean;
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

function isPrivateIpv6(hostname: string): boolean {
    const normalized = stripIpv6Brackets(hostname).toLowerCase();
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

    // 单标签主机名通常来自内网或本地解析环境，这里直接拒绝。
    return !normalized.includes('.');
}

/**
 * 解析 WebFetch 参数，并在真正发请求前完成 URL 安全边界校验。
 *
 * @param args 工具参数。
 * @returns 标准化后的 WebFetch 请求对象。
 */
export function parseWebFetchRequest(args: Record<string, unknown>): WebFetchRequest {
    const parsedArgs = parseToolArguments(WEB_FETCH_TOOL_NAME, webFetchArgsSchema, args);
    const rawUrl = parsedArgs.url;

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(rawUrl);
    } catch {
        throw new Error(`WebFetch tool received an invalid URL: ${rawUrl}`);
    }

    if (!SUPPORTED_PROTOCOLS.has(parsedUrl.protocol)) {
        throw new Error('WebFetch tool only supports http:// and https:// URLs.');
    }

    if (parsedUrl.username || parsedUrl.password) {
        throw new Error('WebFetch tool does not allow embedded credentials in URLs.');
    }

    if (isDisallowedHostname(parsedUrl.hostname)) {
        throw new Error(
            'WebFetch tool blocks localhost, private-network and single-label hostnames.'
        );
    }

    return {
        url: parsedUrl,
        mode: parsedArgs.mode,
        maxChars: parsedArgs.maxChars,
        timeoutMs: parsedArgs.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
}

export function createRequestSignal(
    upstreamSignal: AbortSignal | undefined,
    timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const onAbort = () => controller.abort(upstreamSignal?.reason);

    if (upstreamSignal?.aborted) {
        onAbort();
    } else if (upstreamSignal) {
        upstreamSignal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = globalThis.setTimeout(() => {
        controller.abort(
            new DOMException(`WebFetch timed out after ${timeoutMs}ms`, 'TimeoutError')
        );
    }, timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => {
            globalThis.clearTimeout(timer);
            if (upstreamSignal) {
                upstreamSignal.removeEventListener('abort', onAbort);
            }
        },
    };
}

export function getContentType(response: Response): string {
    const rawValue = response.headers.get('content-type');
    return (
        normalizeOptionalString(rawValue?.split(';', 1)[0])?.toLowerCase() ||
        'application/octet-stream'
    );
}

function getResponseDecoder(response: Response): TextDecoder {
    const contentType = response.headers.get('content-type') || '';
    const charsetMatch = /charset=([^;]+)/i.exec(contentType);
    const charset = charsetMatch?.[1]?.trim();

    if (!charset) {
        return new TextDecoder();
    }

    try {
        return new TextDecoder(charset);
    } catch {
        return new TextDecoder();
    }
}

export function isHtmlContentType(contentType: string): boolean {
    return contentType === 'text/html' || contentType === 'application/xhtml+xml';
}

function isJsonContentType(contentType: string): boolean {
    return contentType === 'application/json' || contentType.endsWith('+json');
}

function isMarkdownContentType(contentType: string): boolean {
    return contentType === 'text/markdown' || contentType === 'text/x-markdown';
}

export function isTextualContentType(contentType: string): boolean {
    return (
        isHtmlContentType(contentType) ||
        isJsonContentType(contentType) ||
        isMarkdownContentType(contentType) ||
        contentType.startsWith('text/') ||
        contentType === 'application/xml' ||
        contentType.endsWith('+xml') ||
        contentType === 'image/svg+xml'
    );
}

export async function readResponseText(
    response: Response,
    maxSourceChars = DEFAULT_SOURCE_CHAR_LIMIT
): Promise<ResponseTextPayload> {
    if (!response.body) {
        return {
            text: await response.text(),
            sourceTruncated: false,
        };
    }

    const reader = response.body.getReader();
    const decoder = getResponseDecoder(response);
    let text = '';
    let sourceTruncated = false;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            text += decoder.decode(value, { stream: true });
            if (text.length > maxSourceChars) {
                // 源内容上限要在解析前生效，避免超大页面把 DOMParser / Readability 拖进高内存占用。
                text = text.slice(0, maxSourceChars);
                sourceTruncated = true;
                await reader.cancel('WebFetch source character limit reached');
                break;
            }
        }

        text += decoder.decode();
    } finally {
        reader.releaseLock();
    }

    return {
        text,
        sourceTruncated,
    };
}

function normalizePlainText(value: string): string {
    return value
        .replace(/\r\n?/g, '\n')
        .split('\0')
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[^\S\n]{2,}/g, ' ')
        .trim();
}

function normalizeMarkdown(value: string): string {
    return value
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function normalizeStructuredText(rawText: string, contentType: string): string {
    if (isJsonContentType(contentType)) {
        try {
            return JSON.stringify(JSON.parse(rawText), null, 2).trim();
        } catch {
            return normalizePlainText(rawText);
        }
    }

    if (isMarkdownContentType(contentType)) {
        return normalizeMarkdown(rawText);
    }

    return normalizePlainText(rawText);
}

export function extractHtmlContent(html: string, request: WebFetchRequest): FormattedFetchPayload {
    if (request.mode === 'reader') {
        // reader 模式优先取主内容，但很多站点的文章结构并不稳定；
        // 解析失败时继续回退到整页 Markdown / 纯文本，保证工具尽量给出可读结果。
        const article = extractReadableArticle(html, request.url.toString());
        if (article) {
            const truncated = truncateContent(article.content, request.maxChars);
            return {
                ...article,
                content: truncated.content,
                bodyTruncated: truncated.bodyTruncated,
            };
        }
    }

    if (request.mode === 'page_text') {
        const content = buildPageText(html);
        const truncated = truncateContent(content, request.maxChars);
        return {
            content: truncated.content,
            actualMode: 'page_text',
            bodyTruncated: truncated.bodyTruncated,
            sourceTruncated: false,
        };
    }

    const markdown = buildPageMarkdown(html, request.url.toString());
    if (markdown) {
        const pageTitle = normalizeOptionalString(
            new DOMParser().parseFromString(html, 'text/html').title || undefined
        );
        const truncated = truncateContent(markdown, request.maxChars);
        return {
            content: truncated.content,
            actualMode: 'page_markdown',
            bodyTruncated: truncated.bodyTruncated,
            sourceTruncated: false,
            title: pageTitle,
        };
    }

    const content = buildPageText(html);
    const truncated = truncateContent(content, request.maxChars);
    return {
        content: truncated.content,
        actualMode: 'page_text',
        bodyTruncated: truncated.bodyTruncated,
        sourceTruncated: false,
    };
}

function pruneNonContentNodes(root: ParentNode): void {
    root.querySelectorAll(
        [
            'script',
            'style',
            'noscript',
            'template',
            'iframe',
            'canvas',
            'svg',
            'form',
            'button',
            'input',
            'select',
            'textarea',
            'nav',
            'aside',
            'footer',
        ].join(', ')
    ).forEach((node) => node.remove());

    root.querySelectorAll('[hidden], [aria-hidden="true"]').forEach((node) => node.remove());
}

function absolutizeResourceUrls(root: ParentNode, baseUrl: string): void {
    root.querySelectorAll<HTMLElement>('[href], [src]').forEach((element) => {
        for (const attributeName of ['href', 'src']) {
            const rawValue = element.getAttribute(attributeName);
            if (
                !rawValue ||
                rawValue.startsWith('#') ||
                rawValue.startsWith('data:') ||
                rawValue.startsWith('javascript:')
            ) {
                continue;
            }

            try {
                element.setAttribute(attributeName, new URL(rawValue, baseUrl).toString());
            } catch {
                // 非法 URL 片段直接保留原样，避免因为单个属性失败而中断整个转换流程。
            }
        }
    });
}

function createTurndownService(): TurndownService {
    // Markdown 比纯文本更利于模型阅读层级、链接和代码块，因此 HTML 路径统一优先转为 Markdown。
    const service = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
        strongDelimiter: '**',
        emDelimiter: '_',
        linkStyle: 'inlined',
    });

    service.addRule('image-alt-text', {
        filter: 'img',
        replacement(_content, node) {
            const altText = normalizeOptionalString(node.getAttribute('alt'));
            const source = normalizeOptionalString(node.getAttribute('src'));

            if (altText && source) {
                return `![${altText}](${source})`;
            }

            if (altText) {
                return `[图片: ${altText}]`;
            }

            return '';
        },
    });

    return service;
}

export function buildPageMarkdown(html: string, baseUrl: string): string {
    const document = new DOMParser().parseFromString(html, 'text/html');
    pruneNonContentNodes(document);
    absolutizeResourceUrls(document, baseUrl);

    const markdown = turndownService.turndown(document.body || document.documentElement);
    return normalizeMarkdown(markdown);
}

export function buildPageText(html: string): string {
    const document = new DOMParser().parseFromString(html, 'text/html');
    pruneNonContentNodes(document);
    return normalizePlainText(
        document.body?.textContent || document.documentElement.textContent || ''
    );
}

export function extractReadableArticle(
    html: string,
    baseUrl: string
): FormattedFetchPayload | null {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const readability = new Readability(document, {
        maxElemsToParse: 0,
        keepClasses: false,
    });
    const article = readability.parse();
    if (!article?.content) {
        return null;
    }

    const articleDocument = new DOMParser().parseFromString(article.content, 'text/html');
    absolutizeResourceUrls(articleDocument, baseUrl);

    const markdown = normalizeMarkdown(
        turndownService.turndown(articleDocument.body || articleDocument.documentElement)
    );
    if (!markdown) {
        return null;
    }

    return {
        content: markdown,
        actualMode: 'reader',
        bodyTruncated: false,
        sourceTruncated: false,
        title: normalizeOptionalString(article.title),
        byline: normalizeOptionalString(article.byline),
        siteName: normalizeOptionalString(article.siteName),
        excerpt: normalizeOptionalString(article.excerpt),
        publishedTime: normalizeOptionalString(article.publishedTime),
    };
}

export function truncateContent(
    content: string,
    maxChars: number
): { content: string; bodyTruncated: boolean } {
    if (content.length <= maxChars) {
        return { content, bodyTruncated: false };
    }

    return {
        content: `${content.slice(0, maxChars)}\n\n[正文已截断，共 ${content.length} 个字符]`,
        bodyTruncated: true,
    };
}

export function formatFetchResult(
    request: WebFetchRequest,
    response: Response,
    contentType: string,
    payload: FormattedFetchPayload
): string {
    const headerLines = [
        '网页抓取',
        `请求 URL: ${request.url.toString()}`,
        `最终 URL: ${response.url || request.url.toString()}`,
        `HTTP 状态: ${response.status} ${response.statusText}`.trim(),
        `内容类型: ${contentType}`,
        `请求模式: ${request.mode}`,
        `实际输出: ${payload.actualMode}`,
    ];

    const metadataLines = [
        payload.title ? `标题: ${payload.title}` : '',
        payload.byline ? `作者: ${payload.byline}` : '',
        payload.siteName ? `站点: ${payload.siteName}` : '',
        payload.publishedTime ? `发布时间: ${payload.publishedTime}` : '',
        payload.excerpt ? `摘要: ${payload.excerpt}` : '',
        payload.sourceTruncated
            ? `源内容: 已在 ${DEFAULT_SOURCE_CHAR_LIMIT} 字符处截断后再转换`
            : '',
        payload.bodyTruncated ? `正文输出: 已限制为 ${request.maxChars} 字符` : '',
    ].filter(Boolean);

    return [...headerLines, ...metadataLines, '', payload.content || '[页面无可读内容]'].join('\n');
}

export function formatUnsupportedResponse(
    request: WebFetchRequest,
    response: Response,
    contentType: string
): string {
    return [
        '网页抓取失败',
        `请求 URL: ${request.url.toString()}`,
        `最终 URL: ${response.url || request.url.toString()}`,
        `HTTP 状态: ${response.status} ${response.statusText}`.trim(),
        `内容类型: ${contentType}`,
        '原因: 当前仅支持 HTML、JSON、Markdown、XML 和普通文本响应。',
    ].join('\n');
}
