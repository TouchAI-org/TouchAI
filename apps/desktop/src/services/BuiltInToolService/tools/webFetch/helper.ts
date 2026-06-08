// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

import { t, tt } from '@/i18n';
import { normalizeOptionalString } from '@/utils/text';

import { parseToolArguments } from '../../utils/toolSchema';
import {
    DEFAULT_SOURCE_CHAR_LIMIT,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_RESPONSE_BYTES,
    SUPPORTED_PROTOCOLS,
    WEB_FETCH_TOOL_NAME,
    webFetchArgsSchema,
    type WebFetchMode,
} from './constants';

const turndownService = createTurndownService();
const BLOCKED_RESOURCE_PROTOCOLS = new Set(['data:', 'javascript:', 'vbscript:']);
const IMAGE_SOURCE_ATTRIBUTES = [
    'data-src',
    'data-original',
    'data-lazy-src',
    'data-image-src',
    'data-actualsrc',
    'data-full-src',
    'data-zoom-src',
    'src',
];
const SRCSET_ATTRIBUTES = ['srcset', 'data-srcset', 'data-lazy-srcset'];
const MAX_IMAGE_CANDIDATES = 6;

interface WebFetchRequest {
    url: URL;
    mode: WebFetchMode;
    maxChars: number;
    timeoutMs: number;
    maxResponseBytes: number;
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
    imageCandidates?: string[];
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
        throw new Error(t('builtInTools.webFetch.error.invalidUrl', { url: rawUrl }));
    }

    if (!SUPPORTED_PROTOCOLS.has(parsedUrl.protocol)) {
        throw new Error(t('builtInTools.webFetch.error.unsupportedProtocol'));
    }

    if (parsedUrl.username || parsedUrl.password) {
        throw new Error(t('builtInTools.webFetch.error.embeddedCredentials'));
    }

    if (isDisallowedHostname(parsedUrl.hostname)) {
        throw new Error(t('builtInTools.webFetch.error.blockedHost'));
    }

    return {
        url: parsedUrl,
        mode: parsedArgs.mode,
        maxChars: parsedArgs.maxChars,
        timeoutMs: parsedArgs.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxResponseBytes: parsedArgs.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
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
            new DOMException(
                t('builtInTools.webFetch.error.timeout', { timeoutMs }),
                'TimeoutError'
            )
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
    maxSourceChars = DEFAULT_SOURCE_CHAR_LIMIT,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
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
    let bytesRead = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            bytesRead += value.byteLength;
            if (bytesRead > maxResponseBytes) {
                sourceTruncated = true;
                await reader.cancel('WebFetch response byte limit reached');
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
    const imageCandidates = extractImageMarkdownCandidates(html, request.url.toString());

    if (request.mode === 'reader') {
        // reader 模式优先取主内容，但很多站点的文章结构并不稳定；
        // 解析失败时继续回退到整页 Markdown / 纯文本，保证工具尽量给出可读结果。
        const article = extractReadableArticle(html, request.url.toString());
        if (article) {
            const truncated = truncateContent(article.content, request.maxChars);
            return withImageCandidates({
                ...article,
                content: truncated.content,
                bodyTruncated: truncated.bodyTruncated,
            }, imageCandidates);
        }
    }

    if (request.mode === 'page_text') {
        const content = buildPageText(html);
        const truncated = truncateContent(content, request.maxChars);
        return withImageCandidates({
            content: truncated.content,
            actualMode: 'page_text',
            bodyTruncated: truncated.bodyTruncated,
            sourceTruncated: false,
        }, imageCandidates);
    }

    const markdown = buildPageMarkdown(html, request.url.toString());
    if (markdown) {
        const pageTitle = normalizeOptionalString(
            new DOMParser().parseFromString(html, 'text/html').title || undefined
        );
        const truncated = truncateContent(markdown, request.maxChars);
        return withImageCandidates({
            content: truncated.content,
            actualMode: 'page_markdown',
            bodyTruncated: truncated.bodyTruncated,
            sourceTruncated: false,
            title: pageTitle,
        }, imageCandidates);
    }

    const content = buildPageText(html);
    const truncated = truncateContent(content, request.maxChars);
    return withImageCandidates({
        content: truncated.content,
        actualMode: 'page_text',
        bodyTruncated: truncated.bodyTruncated,
        sourceTruncated: false,
    }, imageCandidates);
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
            if (!rawValue || rawValue.trimStart().startsWith('#')) {
                continue;
            }

            try {
                const absoluteUrl = new URL(rawValue, baseUrl);
                if (BLOCKED_RESOURCE_PROTOCOLS.has(absoluteUrl.protocol.toLowerCase())) {
                    element.removeAttribute(attributeName);
                    continue;
                }

                element.setAttribute(attributeName, absoluteUrl.toString());
            } catch {
                // 非法 URL 片段直接保留原样，避免因为单个属性失败而中断整个转换流程。
            }
        }
    });
}

function resolveSafeResourceUrl(rawValue: string, baseUrl: string): string | null {
    if (!rawValue || rawValue.trimStart().startsWith('#')) {
        return null;
    }

    const absoluteUrl = new URL(rawValue, baseUrl);
    if (BLOCKED_RESOURCE_PROTOCOLS.has(absoluteUrl.protocol.toLowerCase())) {
        return null;
    }

    return absoluteUrl.toString();
}

function parseSrcsetCandidate(candidate: string): { url: string; descriptor: string } | null {
    const trimmed = candidate.trim();
    if (!trimmed) {
        return null;
    }

    const [url, ...descriptorParts] = trimmed.split(/\s+/);
    if (!url) {
        return null;
    }

    return {
        url,
        descriptor: descriptorParts.join(' '),
    };
}

function parseSrcset(value: string): Array<{ url: string; descriptor: string }> {
    return value
        .split(',')
        .map(parseSrcsetCandidate)
        .filter((candidate): candidate is { url: string; descriptor: string } =>
            Boolean(candidate)
        );
}

function absolutizeSrcset(value: string, baseUrl: string): string | null {
    const candidates = parseSrcset(value)
        .map((candidate) => {
            try {
                const url = resolveSafeResourceUrl(candidate.url, baseUrl);
                return url ? [url, candidate.descriptor].filter(Boolean).join(' ') : null;
            } catch {
                return null;
            }
        })
        .filter((candidate): candidate is string => Boolean(candidate));

    return candidates.length > 0 ? candidates.join(', ') : null;
}

function absolutizeImageResourceUrls(root: ParentNode, baseUrl: string): void {
    root.querySelectorAll<HTMLElement>('img, source').forEach((element) => {
        for (const attributeName of [...IMAGE_SOURCE_ATTRIBUTES, 'poster']) {
            const rawValue = element.getAttribute(attributeName);
            if (!rawValue) {
                continue;
            }

            try {
                const absoluteUrl = resolveSafeResourceUrl(rawValue, baseUrl);
                if (absoluteUrl) {
                    element.setAttribute(attributeName, absoluteUrl);
                } else {
                    element.removeAttribute(attributeName);
                }
            } catch {
                element.removeAttribute(attributeName);
            }
        }

        for (const attributeName of SRCSET_ATTRIBUTES) {
            const rawValue = element.getAttribute(attributeName);
            if (!rawValue) {
                continue;
            }

            const absoluteSrcset = absolutizeSrcset(rawValue, baseUrl);
            if (absoluteSrcset) {
                element.setAttribute(attributeName, absoluteSrcset);
            } else {
                element.removeAttribute(attributeName);
            }
        }
    });
}

function isLikelyPlaceholderImage(source: string): boolean {
    return /(?:placeholder|spacer|blank|transparent|pixel|tracking|loading)\.(?:gif|png|svg)(?:[?#]|$)/i.test(
        source
    );
}

function bestSrcsetSource(value: string | null): string | null {
    if (!value) {
        return null;
    }

    const candidates = parseSrcset(value);
    return candidates[candidates.length - 1]?.url ?? null;
}

function extractImageSource(node: Element): string | null {
    for (const attributeName of IMAGE_SOURCE_ATTRIBUTES) {
        const value = normalizeOptionalString(node.getAttribute(attributeName));
        if (!value || isLikelyPlaceholderImage(value)) {
            continue;
        }

        return value;
    }

    for (const attributeName of SRCSET_ATTRIBUTES) {
        const source = bestSrcsetSource(node.getAttribute(attributeName));
        if (source && !isLikelyPlaceholderImage(source)) {
            return source;
        }
    }

    const pictureSource = node
        .closest('picture')
        ?.querySelector('source[srcset], source[data-srcset], source[data-lazy-srcset]');
    if (pictureSource) {
        for (const attributeName of SRCSET_ATTRIBUTES) {
            const source = bestSrcsetSource(pictureSource.getAttribute(attributeName));
            if (source && !isLikelyPlaceholderImage(source)) {
                return source;
            }
        }
    }

    return null;
}

function imageFileName(source: string): string | null {
    try {
        const pathname = new URL(source).pathname;
        const fileName = pathname.split('/').pop();
        return normalizeOptionalString(fileName ? decodeURIComponent(fileName) : undefined) ?? null;
    } catch {
        const fileName = source.split(/[\\/]/).pop()?.split(/[?#]/, 1)[0];
        return normalizeOptionalString(fileName) ?? null;
    }
}

function cleanMarkdownImageLabel(value: string): string {
    return value.replace(/\s+/g, ' ').replace(/[[\]\\]/g, '').trim();
}

function extractImageLabel(node: Element, source: string): string {
    const directLabel =
        normalizeOptionalString(node.getAttribute('alt')) ??
        normalizeOptionalString(node.getAttribute('title')) ??
        normalizeOptionalString(node.getAttribute('aria-label'));
    const figureLabel = normalizeOptionalString(
        node.closest('figure')?.querySelector('figcaption')?.textContent ?? undefined
    );

    return cleanMarkdownImageLabel(directLabel ?? figureLabel ?? imageFileName(source) ?? 'image');
}

function isLikelyDecorativeImage(source: string, label: string): boolean {
    const value = `${source} ${label}`.toLowerCase();
    return (
        isLikelyPlaceholderImage(source) ||
        /(?:favicon|sprite|tracking|analytics|beacon|avatar|gravatar|logo|icon)(?:[._/-]|$)/i.test(
            value
        )
    );
}

function uniqueImageElements(document: Document): Element[] {
    const selectors = [
        'article img',
        'main img',
        '[role="main"] img',
        'figure img',
        '.content img',
        '.article img',
        'img',
    ];
    const seen = new Set<Element>();
    const images: Element[] = [];

    for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((image) => {
            if (!seen.has(image)) {
                seen.add(image);
                images.push(image);
            }
        });
    }

    return images;
}

function extractImageMarkdownCandidates(html: string, baseUrl: string): string[] {
    const document = new DOMParser().parseFromString(html, 'text/html');
    pruneNonContentNodes(document);
    absolutizeResourceUrls(document, baseUrl);
    absolutizeImageResourceUrls(document, baseUrl);

    const seenSources = new Set<string>();
    const candidates: string[] = [];

    for (const image of uniqueImageElements(document)) {
        const source = extractImageSource(image);
        if (!source || seenSources.has(source)) {
            continue;
        }

        const label = extractImageLabel(image, source);
        if (isLikelyDecorativeImage(source, label)) {
            continue;
        }

        seenSources.add(source);
        candidates.push(`![${label}](${source})`);

        if (candidates.length >= MAX_IMAGE_CANDIDATES) {
            break;
        }
    }

    return candidates;
}

function addBaseUrl(document: Document, baseUrl: string): void {
    const base = document.createElement('base');
    base.href = baseUrl;
    (document.head || document.documentElement).prepend(base);
}

function withImageCandidates<T extends FormattedFetchPayload>(
    payload: T,
    imageCandidates: string[]
): T {
    return imageCandidates.length > 0 ? { ...payload, imageCandidates } : payload;
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
            const source = extractImageSource(node);

            if (source) {
                return `![${extractImageLabel(node, source)}](${source})`;
            }

            const altText = normalizeOptionalString(node.getAttribute('alt'));
            if (altText) {
                return t('builtInTools.webFetch.imageAltFallback', { altText });
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
    absolutizeImageResourceUrls(document, baseUrl);

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
    addBaseUrl(document, baseUrl);
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
    absolutizeImageResourceUrls(articleDocument, baseUrl);

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
        content: `${content.slice(0, maxChars)}\n\n${tt('[正文已截断，共 {count} 个字符]', {
            count: content.length,
        })}`,
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
        tt('网页抓取'),
        `${tt('请求 URL')}: ${request.url.toString()}`,
        `${tt('最终 URL')}: ${response.url || request.url.toString()}`,
        `${tt('HTTP 状态')}: ${response.status} ${response.statusText}`.trim(),
        `${tt('内容类型')}: ${contentType}`,
        `${tt('请求模式')}: ${request.mode}`,
        `${tt('实际输出')}: ${payload.actualMode}`,
    ];

    const metadataLines = [
        payload.title ? `${tt('标题')}: ${payload.title}` : '',
        payload.byline ? `${tt('作者')}: ${payload.byline}` : '',
        payload.siteName ? `${tt('站点')}: ${payload.siteName}` : '',
        payload.publishedTime ? `${tt('发布时间')}: ${payload.publishedTime}` : '',
        payload.excerpt ? `${tt('摘要')}: ${payload.excerpt}` : '',
        payload.sourceTruncated
            ? tt('源内容: 已在 {limit} 字符处截断后再转换', {
                  limit: DEFAULT_SOURCE_CHAR_LIMIT,
              })
            : '',
        payload.bodyTruncated
            ? tt('正文输出: 已限制为 {maxChars} 字符', { maxChars: request.maxChars })
            : '',
    ].filter(Boolean);

    if (payload.imageCandidates && payload.imageCandidates.length > 0) {
        payload = {
            ...payload,
            content: [
                'Embeddable page image candidates (original webpage images; use relevant ones in the final answer with source attribution):',
                ...payload.imageCandidates,
                '',
                payload.content,
            ].join('\n'),
        };
    }

    return [...headerLines, ...metadataLines, '', payload.content || tt('[页面无可读内容]')].join(
        '\n'
    );
}

export function formatUnsupportedResponse(
    request: WebFetchRequest,
    response: Response,
    contentType: string
): string {
    return [
        tt('网页抓取失败'),
        `${tt('请求 URL')}: ${request.url.toString()}`,
        `${tt('最终 URL')}: ${response.url || request.url.toString()}`,
        `${tt('HTTP 状态')}: ${response.status} ${response.statusText}`.trim(),
        `${tt('内容类型')}: ${contentType}`,
        `${tt('原因')}: ${tt('当前仅支持 HTML、JSON、Markdown、XML 和普通文本响应。')}`,
    ].join('\n');
}
