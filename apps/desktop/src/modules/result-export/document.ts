// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import DOMPurify from 'dompurify';
import { getMarkdown } from 'markstream-vue';

import {
    RESULT_EXPORT_RESOURCE_BUDGET_BYTES,
    RESULT_EXPORT_RESOURCE_TIMEOUT_MS,
    RESULT_EXPORT_SCHEMA,
    type ResultExportDocument,
    ResultExportError,
    type ResultExportMessage,
    type ResultExportResourceFetcher,
    type ResultExportTheme,
    type ResultExportWarning,
    type ResultExportWidget,
    type ResultExportWidgetPresentation,
} from './types';

const WIDGET_OUTER_CSP = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    "connect-src 'none'",
    "frame-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

const WIDGET_INNER_CSP = [
    "default-src 'none'",
    "script-src 'unsafe-inline' data: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://esm.sh",
    "style-src 'unsafe-inline' data: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://esm.sh",
    'img-src data: blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://esm.sh',
    'font-src data: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://esm.sh',
    'media-src data: blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://esm.sh',
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

const CLASSIC_SCRIPT_TYPES = new Set([
    '',
    'application/ecmascript',
    'application/javascript',
    'text/ecmascript',
    'text/javascript',
]);

const OPTIONAL_END_TAGS = new Set([
    'body',
    'caption',
    'colgroup',
    'dd',
    'dt',
    'head',
    'html',
    'li',
    'optgroup',
    'option',
    'p',
    'rp',
    'rt',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
]);

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp']);

const VOID_TAGS = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
]);

const EXTERNAL_CREDENTIAL_PATTERNS = [
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
    /\bAuthorization\s*:\s*(?:Bearer|Basic|Digest|Token)?\s*[A-Za-z0-9._~+/=-]{16,}/i,
    /\bCookie\s*:\s*[^\r\n]{16,}/i,
    /\b(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE|AWS|DEEPSEEK|MOONSHOT|SILICONFLOW)_?(?:API_)?KEY\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{16,}/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

interface WidgetScript {
    attributes: Array<{ name: string; value: string }>;
    source: string;
    src: string;
    type: string;
}

interface WidgetStylesheet {
    attributes: Array<{ name: string; value: string }>;
    href: string;
}

interface ParsedWidgetMarkup {
    content: DocumentFragment;
    styles: string[];
    scripts: WidgetScript[];
    stylesheets: WidgetStylesheet[];
}

interface BuiltWidget {
    document: string;
    onlineResources: boolean;
}

export interface BuildResultExportDocumentOptions {
    message: ResultExportMessage;
    presentation: ResultExportWidgetPresentation;
    fetchResource?: ResultExportResourceFetcher;
}

const resultMarkdown = getMarkdown('touchai-result-export', {
    enableContainers: false,
    markdownItOptions: {
        breaks: true,
        html: false,
        linkify: true,
    },
});

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeCssValue(value: string): string {
    return value.replace(/[;{}<>]/g, '').trim();
}

function safeScriptText(value: string): string {
    return value.replace(/<\/script/gi, '<\\/script');
}

function safeStyleText(value: string): string {
    return value.replace(/<\/style/gi, '<\\/style');
}

function serializeAttributes(attributes: readonly { name: string; value: string }[]): string {
    return attributes
        .filter((attribute) => !attribute.name.startsWith('on'))
        .map((attribute) => ` ${attribute.name}="${escapeHtml(attribute.value)}"`)
        .join('');
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

function readMessageField(message: ResultExportMessage, name: string): string | null {
    const value = (message as unknown as Record<string, unknown>)[name];
    return typeof value === 'string' && value.trim() ? value : null;
}

function visibleTextParts(message: ResultExportMessage): string[] {
    const excluded = new Set(
        [readMessageField(message, 'prompt'), readMessageField(message, 'systemPrompt')].filter(
            (value): value is string => Boolean(value)
        )
    );
    const texts = message.parts.flatMap((part) => {
        const content = part.content;
        return part.type === 'text' && content?.trim() && !excluded.has(content) ? [content] : [];
    });

    if (texts.length || message.parts.some((part) => part.type === 'widget')) {
        return texts;
    }
    return message.content?.trim() ? [message.content] : [];
}

function resolveInlinableResourceUrl(
    url: string,
    allowedResourceHosts: readonly string[]
): string | null {
    try {
        const parsed = new URL(url, 'https://touchai.invalid/');
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        return allowedResourceHosts.includes(parsed.hostname) ? parsed.href : null;
    } catch {
        return null;
    }
}

function visibleWidgetMarkup(message: ResultExportMessage): string[] {
    const widgetById = new Map((message.widgets ?? []).map((widget) => [widget.widgetId, widget]));
    return message.parts.flatMap((part) => {
        const widgetId = part.widgetId;
        if (part.type !== 'widget' || !widgetId) return [];
        const widget = widgetById.get(widgetId);
        return widget?.phase === 'ready'
            ? [widget.title, widget.html].filter((value) => value.trim())
            : [];
    });
}

export function containsHighConfidenceCredentialText(content: string): boolean {
    return EXTERNAL_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(content));
}

export function containsHighConfidenceCredential(message: ResultExportMessage): boolean {
    return containsHighConfidenceCredentialText(
        [...visibleTextParts(message), ...visibleWidgetMarkup(message)].join('\n')
    );
}

function renderMarkdown(content: string): string {
    const rendered = resultMarkdown.render(content);
    // markdown-it escapes raw HTML because `html: false`; its own tags are
    // trusted. Only materialize a DOM when a generated link or image needs URL
    // validation. This keeps large plain results off the expensive sanitizer path.
    if (!/<(?:a|img)\b/i.test(rendered)) {
        return rendered;
    }
    const template = document.createElement('template');
    template.innerHTML = DOMPurify.sanitize(rendered, {
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
    });

    for (const link of template.content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        try {
            const url = new URL(link.href, 'https://touchai.invalid/');
            if (!['http:', 'https:'].includes(url.protocol)) {
                link.replaceWith(...link.childNodes);
                continue;
            }
        } catch {
            link.replaceWith(...link.childNodes);
            continue;
        }
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
    }
    for (const image of template.content.querySelectorAll<HTMLImageElement>('img[src]')) {
        if (!image.src.startsWith('data:image/')) {
            image.remove();
        }
    }
    return template.innerHTML;
}

function scanTagEnd(html: string, start: number): number {
    let quote: '"' | "'" | null = null;
    for (let index = start; index < html.length; index += 1) {
        const char = html[index]!;
        if (quote) {
            if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '>') return index;
    }
    return -1;
}

/**
 * Historical widget rows can end at the persistence boundary anywhere in the
 * markup. A browser parser silently repairs those fragments, so detect the
 * structural truncation before turning one into an iframe.
 */
function isIncompleteWidgetMarkup(html: string): boolean {
    if (!html.trim() || html.includes('\uFFFD')) return true;

    const stack: string[] = [];
    let cursor = 0;
    while (cursor < html.length) {
        const open = html.indexOf('<', cursor);
        if (open === -1) break;
        if (html.startsWith('<!--', open)) {
            const close = html.indexOf('-->', open + 4);
            if (close === -1) return true;
            cursor = close + 3;
            continue;
        }
        if (!/[A-Za-z/!?]/.test(html[open + 1] ?? '')) {
            cursor = open + 1;
            continue;
        }

        const tagEnd = scanTagEnd(html, open + 1);
        if (tagEnd === -1) return true;
        const raw = html.slice(open + 1, tagEnd).trim();
        if (!raw || raw.startsWith('!') || raw.startsWith('?')) {
            cursor = tagEnd + 1;
            continue;
        }

        const closeTag = raw.startsWith('/');
        const match = raw.match(/^\/?([A-Za-z][\w:-]*)/);
        if (!match) {
            cursor = tagEnd + 1;
            continue;
        }
        const tag = match[1]!.toLowerCase();
        const selfClosing = /\/\s*$/.test(raw);

        if (closeTag) {
            if (OPTIONAL_END_TAGS.has(tag) || VOID_TAGS.has(tag)) {
                cursor = tagEnd + 1;
                continue;
            }
            const expected = stack.pop();
            if (expected !== tag) return true;
            cursor = tagEnd + 1;
            continue;
        }

        if (RAW_TEXT_TAGS.has(tag) && !selfClosing) {
            const close = html.toLowerCase().indexOf(`</${tag}`, tagEnd + 1);
            if (close === -1) return true;
            const closeEnd = scanTagEnd(html, close + 2 + tag.length);
            if (closeEnd === -1) return true;
            cursor = closeEnd + 1;
            continue;
        }

        if (!selfClosing && !VOID_TAGS.has(tag) && !OPTIONAL_END_TAGS.has(tag)) {
            stack.push(tag);
        }
        cursor = tagEnd + 1;
    }

    return stack.length > 0;
}

function parseWidgetMarkup(html: string): ParsedWidgetMarkup {
    const isFullDocument = /<(?:!doctype|html|head|body)\b/i.test(html);
    let source: DocumentFragment;
    let head: DocumentFragment | null = null;

    if (isFullDocument) {
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        source = document.createDocumentFragment();
        source.append(...Array.from(parsed.body.childNodes));
        head = document.createDocumentFragment();
        head.append(...Array.from(parsed.head.childNodes));
    } else {
        const template = document.createElement('template');
        template.innerHTML = html;
        source = template.content;
    }

    const styles = [...(head?.querySelectorAll('style') ?? []), ...source.querySelectorAll('style')]
        .map((style) => `<style>${safeStyleText(style.textContent ?? '')}</style>`)
        .filter((style, index, all) => all.indexOf(style) === index);
    const stylesheets = [
        ...(head?.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]') ?? []),
        ...source.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'),
    ];
    const scripts = [
        ...(head?.querySelectorAll<HTMLScriptElement>('script') ?? []),
        ...source.querySelectorAll<HTMLScriptElement>('script'),
    ];

    for (const element of [
        ...stylesheets,
        ...scripts,
        ...source.querySelectorAll('style, link[rel~="stylesheet"]'),
    ]) {
        element.remove();
    }

    return {
        content: source,
        styles,
        stylesheets: stylesheets.map((stylesheet) => ({
            href: stylesheet.href,
            attributes: Array.from(stylesheet.attributes).map((attribute) => ({
                name: attribute.name,
                value: attribute.value,
            })),
        })),
        scripts: scripts.map((script) => ({
            src: script.src,
            type: (script.getAttribute('type') ?? '').trim().toLowerCase(),
            source: script.textContent ?? '',
            attributes: Array.from(script.attributes).map((attribute) => ({
                name: attribute.name,
                value: attribute.value,
            })),
        })),
    };
}

function themeCss(theme: ResultExportTheme, fallbacks: ResultExportTheme): string {
    const merged = { ...fallbacks, ...theme };
    return Object.entries(merged)
        .map(([name, value]) => `${name}:${safeCssValue(value)};`)
        .join('');
}

function buildWidgetBootstrap(): string {
    return `
(() => {
  const notice = document.querySelector('[data-result-offline-action]');
  const showNotice = () => {
    if (notice instanceof HTMLElement) notice.hidden = false;
  };
  window.sendPrompt = () => showNotice();
  window.openLink = (url) => {
    try {
      const parsed = new URL(String(url || ''), location.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      parent.postMessage({ source: 'touchai-result-widget', type: 'open-link', url: parsed.href }, '*');
    } catch {}
  };
  document.addEventListener('click', (event) => {
    const element = event.target instanceof Element ? event.target : null;
    const prompt = element?.closest('[data-send-prompt]')?.getAttribute('data-send-prompt');
    if (prompt?.trim()) {
      event.preventDefault();
      showNotice();
      return;
    }
    const target = element?.closest('[data-open-link]');
    const href = target?.getAttribute('data-open-link') || element?.closest('a[href]')?.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    event.preventDefault();
    window.openLink(href);
  }, true);
  const reportHeight = () => {
    parent.postMessage({
      source: 'touchai-result-widget',
      type: 'resize',
      height: Math.ceil(document.documentElement.getBoundingClientRect().height),
    }, '*');
  };
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(reportHeight).observe(document.documentElement);
  }
  addEventListener('load', reportHeight, { once: true });
})();
`;
}

function buildWidgetDocumentBase(
    presentation: ResultExportWidgetPresentation,
    headContent: string,
    bodyContent: string
): string {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(WIDGET_INNER_CSP)}">
<style>html,body{margin:0;padding:0;background:transparent;overflow-x:hidden}body{color:var(--color-text-primary);font-size:16px;line-height:1.5}${themeCss(
        presentation.theme,
        presentation.themeFallbacks
    )}${presentation.baseStyles}</style>${headContent}
</head>
<body>
<div data-result-offline-action hidden role="status">\u6b64\u64cd\u4f5c\u9700\u8981 TouchAI / This action requires TouchAI</div>
<div data-result-widget>${bodyContent}</div>
<script>${safeScriptText(buildWidgetBootstrap())}</script>
</body>
</html>`;
}

function cancelResponseBody(response: Response): void {
    void response.body?.cancel().catch(() => {});
}

async function readResponseBytes(
    response: Response,
    presentation: ResultExportWidgetPresentation,
    remaining: number,
    remainingMs: number
): Promise<Uint8Array | null> {
    if (!response.ok || remainingMs <= 0 || remaining <= 0) {
        cancelResponseBody(response);
        return null;
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > remaining) {
        cancelResponseBody(response);
        return null;
    }
    if (
        response.url &&
        !resolveInlinableResourceUrl(response.url, presentation.allowedResourceHosts)
    ) {
        cancelResponseBody(response);
        return null;
    }

    if (!response.body) {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            const result = await Promise.race([
                response.arrayBuffer(),
                new Promise<null>((resolve) => {
                    timer = setTimeout(() => resolve(null), remainingMs);
                }),
            ]);
            return result && result.byteLength <= remaining ? new Uint8Array(result) : null;
        } catch {
            return null;
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    }

    const reader = response.body.getReader();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const readStream = async (): Promise<Uint8Array | null> => {
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                total += chunk.value.byteLength;
                if (total > remaining) {
                    await reader.cancel().catch(() => {});
                    return null;
                }
                chunks.push(chunk.value);
            }
        } catch {
            await reader.cancel().catch(() => {});
            return null;
        }

        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    };

    try {
        return await Promise.race([
            readStream(),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => {
                    void reader.cancel().catch(() => {});
                    resolve(null);
                }, remainingMs);
            }),
        ]);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

async function fetchWithinDeadline(
    fetchResource: ResultExportResourceFetcher | undefined,
    url: string,
    remainingMs: number
): Promise<Response | null> {
    if (!fetchResource || remainingMs <= 0) return null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            fetchResource(url, { signal: controller.signal, redirect: 'error' }),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => {
                    controller.abort();
                    resolve(null);
                }, remainingMs);
            }),
        ]);
    } catch {
        return null;
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

async function inlineWidgetResources(
    parsed: ParsedWidgetMarkup,
    presentation: ResultExportWidgetPresentation,
    fetchResource: ResultExportResourceFetcher | undefined
): Promise<{
    scripts: WidgetScript[];
    styles: string[];
    stylesheets: WidgetStylesheet[];
    onlineResources: boolean;
}> {
    const deadline = Date.now() + RESULT_EXPORT_RESOURCE_TIMEOUT_MS;
    let remaining = RESULT_EXPORT_RESOURCE_BUDGET_BYTES;
    let onlineResources = false;
    const styles = [...parsed.styles];
    const scripts: WidgetScript[] = [];
    const stylesheets: WidgetStylesheet[] = [];

    for (const stylesheet of parsed.stylesheets) {
        const resourceUrl = resolveInlinableResourceUrl(
            stylesheet.href,
            presentation.allowedResourceHosts
        );
        if (!resourceUrl) continue;
        const response = await fetchWithinDeadline(
            fetchResource,
            resourceUrl,
            deadline - Date.now()
        );
        const bytes = response
            ? await readResponseBytes(response, presentation, remaining, deadline - Date.now())
            : null;
        if (!bytes) {
            stylesheets.push({ ...stylesheet, href: resourceUrl });
            onlineResources = true;
            continue;
        }
        remaining -= bytes.byteLength;
        const source = new TextDecoder().decode(bytes);
        if (containsHighConfidenceCredentialText(source)) {
            throw new ResultExportError(
                'sensitive-content',
                'Sensitive credentials cannot be exported.'
            );
        }
        styles.push(`<style>${safeStyleText(source)}</style>`);
    }

    for (const script of parsed.scripts) {
        if (!script.src) {
            if (CLASSIC_SCRIPT_TYPES.has(script.type)) scripts.push(script);
            continue;
        }
        const resourceUrl = resolveInlinableResourceUrl(
            script.src,
            presentation.allowedResourceHosts
        );
        if (!resourceUrl) continue;
        const response = await fetchWithinDeadline(
            fetchResource,
            resourceUrl,
            deadline - Date.now()
        );
        const bytes = response
            ? await readResponseBytes(response, presentation, remaining, deadline - Date.now())
            : null;
        if (!bytes) {
            scripts.push({ ...script, src: resourceUrl });
            onlineResources = true;
            continue;
        }
        remaining -= bytes.byteLength;
        if (containsHighConfidenceCredentialText(new TextDecoder().decode(bytes))) {
            throw new ResultExportError(
                'sensitive-content',
                'Sensitive credentials cannot be exported.'
            );
        }
        const dataUrl = `data:text/javascript;base64,${bytesToBase64(bytes)}`;
        scripts.push({
            ...script,
            src: dataUrl,
            attributes: script.attributes
                .filter(
                    (attribute) =>
                        !['integrity', 'crossorigin', 'onload', 'onerror'].includes(attribute.name)
                )
                .map((attribute) =>
                    attribute.name === 'src' ? { name: 'src', value: dataUrl } : attribute
                ),
        });
    }

    return { scripts, styles, stylesheets, onlineResources };
}

function renderScript(script: WidgetScript): string {
    if (script.src.startsWith('data:text/javascript;base64,')) {
        const attributes = script.attributes
            .filter((attribute) => attribute.name !== 'src')
            .concat({ name: 'src', value: script.src });
        return `<script${serializeAttributes(attributes)}></script>`;
    }
    if (script.src) {
        return `<script${serializeAttributes(script.attributes)}></script>`;
    }
    return `<script${serializeAttributes(script.attributes)}>${safeScriptText(script.source)}</script>`;
}

async function buildWidget(
    widget: ResultExportWidget,
    presentation: ResultExportWidgetPresentation,
    fetchResource: ResultExportResourceFetcher | undefined
): Promise<BuiltWidget | null> {
    if (widget.phase !== 'ready' || isIncompleteWidgetMarkup(widget.html)) {
        return null;
    }

    const parsed = parseWidgetMarkup(widget.html);
    const resources = await inlineWidgetResources(parsed, presentation, fetchResource);
    const sanitized = DOMPurify.sanitize(parsed.content, {
        ADD_TAGS: ['style'],
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'meta', 'link'],
    });
    const headContent = [
        ...resources.styles,
        ...resources.stylesheets.map(
            (stylesheet) =>
                `<link${serializeAttributes(
                    stylesheet.attributes.filter((attribute) => attribute.name !== 'href')
                )} href="${escapeHtml(stylesheet.href)}">`
        ),
    ].join('');
    const scripts = resources.scripts.map(renderScript).join('');
    return {
        document: buildWidgetDocumentBase(presentation, headContent, `${sanitized}${scripts}`),
        onlineResources: resources.onlineResources,
    };
}

function widgetFallback(widget: ResultExportWidget | undefined): string {
    const title = widget?.title.trim();
    return `<div data-result-part="widget" data-widget-fallback role="note"><strong>${escapeHtml(
        title || 'Widget'
    )}</strong><p>This visualization could not be reconstructed. The saved result data is incomplete.</p></div>`;
}

function renderDocumentBody(
    message: ResultExportMessage,
    widgetDocuments: ReadonlyMap<string, BuiltWidget | null>
): string {
    const widgets = new Map((message.widgets ?? []).map((widget) => [widget.widgetId, widget]));
    const excludedText = new Set(
        [readMessageField(message, 'prompt'), readMessageField(message, 'systemPrompt')].filter(
            (value): value is string => Boolean(value)
        )
    );
    const blocks: string[] = [];

    for (const part of message.parts) {
        const content = part.content;
        if (part.type === 'text') {
            if (!content?.trim() || excludedText.has(content)) continue;
            blocks.push(
                `<section data-result-part="text" class="result-text">${renderMarkdown(content)}</section>`
            );
            continue;
        }
        if (part.type === 'widget') {
            const widgetId = part.widgetId;
            if (!widgetId) {
                blocks.push(widgetFallback(undefined));
                continue;
            }
            const widget = widgets.get(widgetId);
            const built = widgetDocuments.get(widgetId);
            if (!widget || !built) {
                blocks.push(widgetFallback(widget));
                continue;
            }
            blocks.push(
                `<section data-result-part="widget" class="result-widget"><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeHtml(
                    widget.title
                )}" srcdoc="${escapeHtml(built.document)}"></iframe></section>`
            );
        }
    }

    if (!message.parts.some((part) => part.type === 'text' || part.type === 'widget')) {
        for (const content of visibleTextParts(message)) {
            blocks.push(
                `<section data-result-part="text" class="result-text">${renderMarkdown(content)}</section>`
            );
        }
    }
    return blocks.join('\n');
}

function outerDocumentStyles(presentation: ResultExportWidgetPresentation): string {
    return [
        themeCss(presentation.theme, presentation.themeFallbacks),
        `
:root{color-scheme:light dark}
html,body{margin:0;min-height:100%;background:var(--color-background-tertiary)}
body{color:var(--color-text-primary);font-family:var(--font-serif),system-ui,sans-serif;line-height:1.75}
main{width:min(760px,calc(100% - 32px));margin:0 auto;padding:32px 0 48px}
.result-text{overflow-wrap:anywhere}
.result-text :first-child{margin-top:0}
.result-text :last-child{margin-bottom:0}
.result-text h1,.result-text h2,.result-text h3{font-weight:500;line-height:1.3}
.result-text a{color:var(--color-text-info);text-decoration:none}
.result-text a:hover{text-decoration:underline}
.result-text pre{overflow-x:auto;padding:16px;border-radius:var(--border-radius-md);background:var(--color-background-secondary)}
.result-text code{font-family:var(--font-mono),monospace}
.result-text blockquote{margin-inline:0;padding-inline-start:16px;border-inline-start:2px solid var(--color-border-secondary);color:var(--color-text-secondary)}
.result-text table{width:100%;border-collapse:collapse}
.result-text th,.result-text td{padding:8px 12px;border-bottom:1px solid var(--color-border-tertiary);text-align:left}
.result-widget{margin:20px 0}
.result-widget iframe{display:block;width:100%;min-height:160px;border:0;background:transparent}
[data-widget-fallback]{padding:16px;border:1px solid var(--color-border-secondary);border-radius:var(--border-radius-md);background:var(--color-background-secondary);color:var(--color-text-secondary)}
[data-widget-fallback] strong{display:block;color:var(--color-text-primary);font-weight:500}
[data-widget-fallback] p{margin:8px 0 0}
@media (max-width:600px){main{width:min(100% - 20px,760px);padding-top:20px}}
`,
    ].join('');
}

function outerBootstrap(): string {
    return `
(() => {
  const frames = new Map(
    Array.from(document.querySelectorAll('iframe')).map((frame) => [frame.contentWindow, frame])
  );
  addEventListener('message', (event) => {
    const frame = frames.get(event.source);
    if (!frame || !event.data || event.data.source !== 'touchai-result-widget') return;
    if (event.data.type === 'resize') {
      const height = Number(event.data.height);
      if (Number.isFinite(height) && height > 0) {
        frame.style.height = Math.min(Math.max(Math.ceil(height), 160), 20000) + 'px';
      }
      return;
    }
    if (event.data.type === 'open-link') {
      try {
        const url = new URL(String(event.data.url || ''));
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          window.open(url.href, '_blank', 'noopener,noreferrer');
        }
      } catch {}
    }
  });
})();
`;
}

export async function buildResultExportDocument({
    message,
    presentation,
    fetchResource,
}: BuildResultExportDocumentOptions): Promise<ResultExportDocument> {
    const widgetById = new Map((message.widgets ?? []).map((widget) => [widget.widgetId, widget]));
    const widgetDocuments = new Map<string, BuiltWidget | null>();
    const warnings = new Set<ResultExportWarning>();

    for (const part of message.parts) {
        const widgetId = part.widgetId;
        if (part.type !== 'widget' || !widgetId || widgetDocuments.has(widgetId)) continue;
        const widget = widgetById.get(widgetId);
        const built = widget ? await buildWidget(widget, presentation, fetchResource) : null;
        widgetDocuments.set(widgetId, built);
        if (built?.onlineResources) warnings.add('online-resources');
    }

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="touchai-result-schema" content="${RESULT_EXPORT_SCHEMA}">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(WIDGET_OUTER_CSP)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TouchAI result</title>
<style>${outerDocumentStyles(presentation)}</style>
</head>
<body>
<main>${renderDocumentBody(message, widgetDocuments)}</main>
<script>${safeScriptText(outerBootstrap())}</script>
</body>
</html>`;

    return {
        html,
        bytes: new TextEncoder().encode(html).byteLength,
        warnings: [...warnings],
    };
}
