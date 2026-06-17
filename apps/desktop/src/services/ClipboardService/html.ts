import DOMPurify from 'dompurify';
import TurndownService from 'turndown';

import type {
    ClipboardHtmlImage,
    ClipboardPayload,
    ClipboardPayloadFragment,
} from '@/services/NativeService/types';

interface HtmlClipboardText {
    markdown: string | null;
    features: HtmlClipboardFeatures;
}

interface HtmlClipboardFeatures {
    hasBlockquote: boolean;
    hasCode: boolean;
    hasHeading: boolean;
    hasImage: boolean;
    hasLink: boolean;
    hasList: boolean;
    hasTable: boolean;
}

const turndownService = createTurndownService();
const clipboardAllowedUriRegexp =
    /^(?:(?:https?|mailto|tel|ftp|file|blob|cid):|data:image\/|[^a-z]|[a-z0-9.+-]+(?:[^a-z0-9.+:-]|$))/i;

export function normalizeClipboardPayload(
    payload: ClipboardPayload | null,
    options: { preservePlainText?: boolean } = {}
): ClipboardPayload | null {
    if (!payload?.html?.trim()) {
        return payload;
    }

    const htmlText = convertClipboardHtmlToMarkdown(payload.html, payload.htmlSourceUrl ?? null);
    const text = chooseClipboardText(payload.text, htmlText, options.preservePlainText ?? false);
    const fragments = buildClipboardFragments({
        text,
        htmlText,
        htmlImages: payload.htmlImages ?? [],
        imagePaths: payload.imagePaths ?? [],
        nativeFragments: payload.fragments,
    });

    return {
        ...payload,
        text,
        fragments: fragments.length > 0 ? fragments : payload.fragments,
    };
}

function convertClipboardHtmlToMarkdown(html: string, sourceUrl: string | null): HtmlClipboardText {
    const cleanHtml = DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'script', 'noscript', 'template', 'meta', 'link', 'title'],
        ALLOWED_URI_REGEXP: clipboardAllowedUriRegexp,
    });
    const document = new DOMParser().parseFromString(String(cleanHtml), 'text/html');
    pruneClipboardArtifacts(document);
    sanitizeClipboardReferences(document, sourceUrl);

    const markdown = normalizeMarkdown(
        turndownService.turndown(document.body || document.documentElement)
    );

    return {
        markdown: markdown || null,
        features: detectHtmlClipboardFeatures(document),
    };
}

function chooseClipboardText(
    plainText: string | null,
    htmlText: HtmlClipboardText,
    preservePlainText: boolean
): string | null {
    const plain = normalizePlainText(plainText, preservePlainText);
    const plainForDecision = normalizePlainText(plainText);
    if (!htmlText.markdown) {
        return plain;
    }
    if (!plainForDecision) {
        return htmlText.markdown;
    }

    return shouldPreferHtmlMarkdown(plainForDecision, htmlText) ? htmlText.markdown : plain;
}

function buildClipboardFragments(input: {
    text: string | null;
    htmlText: HtmlClipboardText;
    htmlImages: ClipboardHtmlImage[];
    imagePaths: string[];
    nativeFragments: ClipboardPayloadFragment[] | undefined;
}): ClipboardPayloadFragment[] {
    const { text, htmlText, htmlImages, imagePaths, nativeFragments } = input;
    const fileFragments = (nativeFragments ?? []).filter(
        (fragment): fragment is Extract<ClipboardPayloadFragment, { type: 'file' }> =>
            fragment.type === 'file'
    );
    const fallbackImagePaths = buildFallbackImagePaths(imagePaths, nativeFragments);
    const orderedMarkdown = htmlText.markdown ?? text;

    if (!text?.trim()) {
        return [
            ...fallbackImagePaths.map(
                (path) => ({ type: 'image', path }) as ClipboardPayloadFragment
            ),
            ...fileFragments,
        ];
    }

    if (orderedMarkdown && (htmlImages.length > 0 || fallbackImagePaths.length > 0)) {
        const orderedFragments = splitMarkdownImagesIntoFragments(
            orderedMarkdown,
            htmlImages,
            fallbackImagePaths
        );
        if (orderedFragments.length > 0) {
            return [
                ...orderedFragments,
                ...fallbackImagePaths.map(
                    (path) => ({ type: 'image', path }) as ClipboardPayloadFragment
                ),
                ...fileFragments,
            ];
        }
    }

    return [
        { type: 'text', text },
        ...fallbackImagePaths.map((path) => ({ type: 'image', path }) as ClipboardPayloadFragment),
        ...fileFragments,
    ];
}

function splitMarkdownImagesIntoFragments(
    markdown: string,
    htmlImages: ClipboardHtmlImage[],
    fallbackImagePaths: string[]
): ClipboardPayloadFragment[] {
    const fragments: ClipboardPayloadFragment[] = [];
    let textBuffer = '';
    let imageIndex = 0;
    let remaining = markdown;

    while (remaining) {
        const imageStart = remaining.indexOf('![');
        if (imageStart < 0) {
            textBuffer += remaining;
            break;
        }

        const parsed = parseMarkdownImageOccurrence(remaining, imageStart);
        if (!parsed) {
            textBuffer += remaining.slice(0, imageStart);
            textBuffer += remaining.slice(imageStart, imageStart + 2);
            remaining = remaining.slice(imageStart + 2);
            continue;
        }

        textBuffer += remaining.slice(0, parsed.start);
        const image = htmlImages[imageIndex];
        imageIndex += 1;
        const imagePath = image?.path ?? shiftFirstClipboardImagePath(fallbackImagePaths);
        if (imagePath) {
            removeFirstMatchingClipboardImagePath(fallbackImagePaths, imagePath);
            pushTextFragment(fragments, textBuffer);
            textBuffer = '';
            fragments.push({ type: 'image', path: imagePath });
        } else {
            textBuffer += remaining.slice(imageStart, imageStart + parsed.length);
        }

        remaining = remaining.slice(parsed.start + parsed.length);
    }

    pushTextFragment(fragments, textBuffer);
    return fragments;
}

function parseMarkdownImageOccurrence(
    markdown: string,
    imageStart: number
): { start: number; length: number } | null {
    const imageToken = parseMarkdownImageToken(markdown.slice(imageStart));
    if (!imageToken) {
        return null;
    }

    const imageEnd = imageStart + imageToken.length;
    if (
        imageStart > 0 &&
        markdown[imageStart - 1] === '[' &&
        markdown[imageEnd] === ']' &&
        markdown[imageEnd + 1] === '('
    ) {
        const linkDestinationEnd = findMarkdownDestinationEnd(markdown, imageEnd + 2);
        if (linkDestinationEnd >= 0) {
            const linkedImageStart = imageStart - 1;
            return {
                start: linkedImageStart,
                length: linkDestinationEnd - linkedImageStart + 1,
            };
        }
    }

    return { start: imageStart, length: imageToken.length };
}

function parseMarkdownImageToken(markdown: string): { length: number } | null {
    if (!markdown.startsWith('![')) {
        return null;
    }

    const labelEnd = findUnescapedChar(markdown, ']', 2);
    if (labelEnd < 0 || markdown[labelEnd + 1] !== '(') {
        return null;
    }

    const destinationEnd = findMarkdownDestinationEnd(markdown, labelEnd + 2);
    if (destinationEnd < 0) {
        return null;
    }

    return { length: destinationEnd + 1 };
}

function findUnescapedChar(value: string, target: string, start: number): number {
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
        const char = value[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === target) {
            return index;
        }
    }

    return -1;
}

function findMarkdownDestinationEnd(value: string, start: number): number {
    let escaped = false;
    let angleDepth = 0;
    for (let index = start; index < value.length; index += 1) {
        const char = value[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === '<') {
            angleDepth += 1;
            continue;
        }
        if (char === '>' && angleDepth > 0) {
            angleDepth -= 1;
            continue;
        }
        if (char === ')' && angleDepth === 0) {
            return index;
        }
    }

    return -1;
}

function pushTextFragment(fragments: ClipboardPayloadFragment[], text: string): void {
    const normalized = text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/^\n+|\n+$/g, '');
    if (normalized.length > 0) {
        fragments.push({
            type: 'text',
            text: normalized.includes('\n') ? normalized.trim() : normalized,
        });
    }
}

function buildFallbackImagePaths(
    imagePaths: string[],
    nativeFragments: ClipboardPayloadFragment[] | undefined
): string[] {
    const paths = [
        ...imagePaths,
        ...(nativeFragments ?? [])
            .filter(
                (fragment): fragment is Extract<ClipboardPayloadFragment, { type: 'image' }> =>
                    fragment.type === 'image'
            )
            .map((fragment) => fragment.path),
    ];

    return Array.from(new Set(paths));
}

function shiftFirstClipboardImagePath(paths: string[]): string | null {
    return paths.length > 0 ? (paths.shift() ?? null) : null;
}

function removeFirstMatchingClipboardImagePath(paths: string[], target: string): void {
    const index = paths.indexOf(target);
    if (index >= 0) {
        paths.splice(index, 1);
    }
}

function createTurndownService(): TurndownService {
    const service = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
        strongDelimiter: '**',
        emDelimiter: '_',
        linkStyle: 'inlined',
    });

    service.addRule('clipboard-table', {
        filter: 'table',
        replacement(_content, node) {
            return `\n\n${formatPlainTextTable(node as HTMLTableElement)}\n\n`;
        },
    });

    service.addRule('clipboard-strikethrough', {
        filter: (node) => ['DEL', 'S', 'STRIKE'].includes(node.nodeName),
        replacement(content) {
            return content.trim() ? `~~${content}~~` : '';
        },
    });

    service.addRule('clipboard-mark', {
        filter: 'mark',
        replacement(content) {
            return content.trim() ? `==${content}==` : '';
        },
    });

    service.addRule('clipboard-image-placeholder', {
        filter: 'img',
        replacement(_content, node) {
            const image = node as HTMLImageElement;
            const source = image.currentSrc || image.src || image.getAttribute('src');
            return source ? `![${escapeMarkdownTableText(image.alt || '')}](${source})` : '';
        },
    });

    service.addRule('clipboard-linked-image', {
        filter: (node) => {
            if (node.nodeName !== 'A') {
                return false;
            }

            const link = node as HTMLAnchorElement;
            return Boolean(link.querySelector('img') && !link.textContent?.trim());
        },
        replacement(content) {
            return content;
        },
    });

    return service;
}

function formatPlainTextTable(table: HTMLTableElement): string {
    const rows = Array.from(table.rows)
        .map((row) =>
            Array.from(row.cells).map((cell) =>
                normalizeTableCellText(cell.textContent ?? '').replace(/\t/g, ' ')
            )
        )
        .filter((row) => row.length > 0);

    if (rows.length === 0) {
        return '';
    }

    const columnCount = Math.max(...rows.map((row) => row.length));
    return rows
        .map((row) => Array.from({ length: columnCount }, (_value, index) => row[index] ?? ''))
        .map((row) => row.join('\t'))
        .join('\n');
}

function normalizeTableCellText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function normalizeMarkdown(markdown: string): string {
    return normalizeMarkdownListMarkerSpacing(markdown)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeMarkdownListMarkerSpacing(markdown: string): string {
    const lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let inFence = false;

    return lines
        .map((line) => {
            if (/^\s*```/.test(line)) {
                inFence = !inFence;
                return line;
            }
            if (inFence) {
                return line;
            }

            return line
                .replace(/^(\s*)([-+*])\s{2,}(?=\S)/, '$1$2 ')
                .replace(/^(\s*)(\d+\.)\s{2,}(?=\S)/, '$1$2 ');
        })
        .join('\n');
}

function normalizePlainText(
    text: string | null | undefined,
    preserveBoundaryWhitespace = false
): string | null {
    const normalized = text?.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const output = preserveBoundaryWhitespace ? normalized : normalized?.trim();
    if (!output || !output.trim()) {
        return null;
    }

    return output;
}

function pruneClipboardArtifacts(document: Document): void {
    document
        .querySelectorAll(
            [
                'style',
                'script',
                'noscript',
                'template',
                'meta',
                'link',
                'title',
                '[hidden]',
                '[aria-hidden="true"]',
            ].join(',')
        )
        .forEach((node) => node.remove());

    document.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
        if (isHiddenInlineStyle(element.getAttribute('style') ?? '')) {
            element.remove();
        }
    });
}

function isHiddenInlineStyle(style: string): boolean {
    const normalized = style.replace(/\s+/g, '').toLowerCase();
    return (
        normalized.includes('display:none') ||
        normalized.includes('visibility:hidden') ||
        normalized.includes('opacity:0')
    );
}

function sanitizeClipboardReferences(document: Document, sourceUrl: string | null): void {
    const base = sourceUrl ? parseUrl(sourceUrl) : null;
    document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => {
        const href = sanitizeClipboardLinkHref(link.getAttribute('href'), base);
        if (href) {
            link.href = href;
        } else {
            link.removeAttribute('href');
        }
    });

    document.querySelectorAll<HTMLImageElement>('img[src]').forEach((image) => {
        const source = sanitizeClipboardImageSource(image.getAttribute('src'), base);
        if (source) {
            image.src = source;
        } else {
            image.removeAttribute('src');
        }
    });
}

function parseUrl(value: string): URL | null {
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

function resolveUrl(value: string | null, base: URL): string | null {
    if (!value?.trim()) {
        return null;
    }

    try {
        return new URL(value, base).toString();
    } catch {
        return null;
    }
}

function getUrlProtocol(value: string): string | null {
    const protocolMatch = /^([a-z][a-z0-9+.-]*:)/i.exec(value.trim());
    return protocolMatch?.[1]?.toLowerCase() ?? null;
}

function sanitizeClipboardLinkHref(value: string | null, base: URL | null): string | null {
    const normalized = value?.trim();
    if (!normalized) {
        return null;
    }
    if (normalized.startsWith('#')) {
        return normalized;
    }

    const resolved = base ? resolveUrl(normalized, base) : normalized;
    if (!resolved) {
        return null;
    }

    const protocol = getUrlProtocol(resolved);
    if (!protocol) {
        return resolved;
    }

    return isAllowedLinkUrl(resolved) ? resolved : null;
}

function sanitizeClipboardImageSource(value: string | null, base: URL | null): string | null {
    const normalized = value?.trim();
    if (!normalized) {
        return null;
    }
    if (/^data:image\//i.test(normalized)) {
        return normalized;
    }

    const resolved = base ? resolveUrl(normalized, base) : normalized;
    if (!resolved) {
        return null;
    }

    const protocol = getUrlProtocol(resolved);
    if (!protocol) {
        return resolved;
    }

    return isAllowedImageUrl(resolved) ? resolved : null;
}

function isAllowedLinkUrl(value: string): boolean {
    return /^(https?|file|mailto|tel|ftp):/i.test(value) || value.startsWith('#');
}

function isAllowedImageUrl(value: string): boolean {
    return /^(https?|file|blob|cid|data:image\/)/i.test(value);
}

function detectHtmlClipboardFeatures(document: Document): HtmlClipboardFeatures {
    return {
        hasBlockquote: Boolean(document.querySelector('blockquote')),
        hasCode: Boolean(document.querySelector('pre, code')),
        hasHeading: Boolean(document.querySelector('h1, h2, h3, h4, h5, h6')),
        hasImage: Boolean(document.querySelector('img')),
        hasLink: Boolean(document.querySelector('a[href]')),
        hasList: Boolean(document.querySelector('ul, ol, li')),
        hasTable: Boolean(document.querySelector('table')),
    };
}

function shouldPreferHtmlMarkdown(plain: string, htmlText: HtmlClipboardText): boolean {
    const markdown = htmlText.markdown;
    if (!markdown) {
        return false;
    }

    const features = htmlText.features;
    if (features.hasLink && markdownAddsLinkDestinations(plain, markdown)) {
        return true;
    }
    if (features.hasCode && markdownAddsCodeSyntax(plain, markdown)) {
        return true;
    }
    if (features.hasTable) {
        return !plainTextHasTableStructure(plain);
    }
    if (features.hasList) {
        return !plainTextHasListStructure(plain);
    }
    if (features.hasHeading || features.hasBlockquote) {
        return !plainTextHasLineStructure(plain) && plainTextHasLineStructure(markdown);
    }

    return false;
}

function plainTextHasLineStructure(text: string): boolean {
    return text.includes('\n');
}

function plainTextHasTableStructure(text: string): boolean {
    return text.includes('\t') || looksLikeMarkdownTable(text);
}

function plainTextHasListStructure(text: string): boolean {
    return /^(?:\s*(?:[-+*•‣◦∙]|\d+[.)])\s+)/m.test(text);
}

function markdownAddsCodeSyntax(plain: string, markdown: string): boolean {
    return (/`[^`]+`/.test(markdown) || /^```/m.test(markdown)) && !/`[^`]+`|^```/m.test(plain);
}

function markdownAddsLinkDestinations(plain: string, markdown: string): boolean {
    return extractMarkdownLinkDestinations(markdown).some(
        (destination) => !plain.includes(destination)
    );
}

function extractMarkdownLinkDestinations(markdown: string): string[] {
    const destinations: string[] = [];
    const linkPattern = /(?<!!)\[[^\]]+]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let match: RegExpExecArray | null;

    while ((match = linkPattern.exec(markdown)) !== null) {
        const destination = match[1];
        if (destination) {
            destinations.push(destination);
        }
    }

    return destinations;
}

function looksLikeMarkdownTable(text: string): boolean {
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const [header, separator] = lines;

    return Boolean(
        header?.startsWith('|') &&
        header.endsWith('|') &&
        separator?.startsWith('|') &&
        separator.endsWith('|') &&
        separator
            .replace(/^\||\|$/g, '')
            .split('|')
            .every((cell) => /^:?-+:?$/.test(cell.trim()))
    );
}

function escapeMarkdownTableText(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}
