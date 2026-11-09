// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import DOMPurify from 'dompurify';

import { MAX_ARTIFACT_HTML_CHARS } from './protocol';
import {
    createVisualReplyThemeSnapshot,
    serializeVisualReplyTheme,
    VISUAL_REPLY_THEME_TOKEN_NAMES,
    type VisualReplyThemeSnapshot,
} from './theme';

const ALLOWED_TAGS = new Set([
    'A',
    'ABBR',
    'ARTICLE',
    'ASIDE',
    'B',
    'BLOCKQUOTE',
    'BR',
    'BUTTON',
    'CANVAS',
    'CAPTION',
    'CIRCLE',
    'CODE',
    'COL',
    'COLGROUP',
    'DD',
    'DEFS',
    'DETAILS',
    'DIV',
    'DL',
    'DT',
    'ELLIPSE',
    'FIELDSET',
    'FIGCAPTION',
    'FIGURE',
    'FOOTER',
    'G',
    'H1',
    'H2',
    'H3',
    'H4',
    'HEADER',
    'HR',
    'I',
    'IMG',
    'INPUT',
    'LABEL',
    'LI',
    'LINE',
    'LINEARGRADIENT',
    'MAIN',
    'MARK',
    'OL',
    'OPTION',
    'P',
    'PATH',
    'POLYGON',
    'POLYLINE',
    'PROGRESS',
    'RECT',
    'SECTION',
    'SELECT',
    'SMALL',
    'SPAN',
    'STOP',
    'STRONG',
    'SUB',
    'SUMMARY',
    'SUP',
    'SVG',
    'TABLE',
    'TBODY',
    'TD',
    'TEXT',
    'TEXTAREA',
    'TFOOT',
    'TH',
    'THEAD',
    'TR',
    'UL',
]);
export function sanitizeArtifactHtml(source: string): string {
    if (source.length > MAX_ARTIFACT_HTML_CHARS) {
        throw new Error(`Artifact exceeds ${MAX_ARTIFACT_HTML_CHARS} characters.`);
    }

    const document = new DOMParser().parseFromString(source, 'text/html');
    const scripts = [...document.querySelectorAll('script')]
        .filter((script) => !script.hasAttribute('src'))
        .filter((script) => ['', 'module'].includes(script.type.trim().toLowerCase()))
        .map((script) => script.textContent ?? '');
    document
        .querySelectorAll('script, iframe, object, embed, form, base, meta, link')
        .forEach((node) => node.remove());
    for (const link of [...document.querySelectorAll('a[href]')]) {
        const href = link.getAttribute('href')?.trim() ?? '';
        if (href && !href.startsWith('#')) {
            link.removeAttribute('href');
            link.removeAttribute('target');
        }
    }

    const styles = [...document.querySelectorAll('style')]
        .map((style) => style.textContent ?? '')
        .filter((style) => !/@import|url\s*\(|expression\s*\(/i.test(style));
    document.querySelectorAll('style').forEach((style) => style.remove());

    const sanitized = DOMPurify.sanitize(document.body.innerHTML, {
        ALLOWED_TAGS: [...ALLOWED_TAGS],
        FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'base', 'meta', 'link'],
        FORBID_ATTR: ['srcdoc', 'formaction'],
    });
    // DOMPurify drops style content by default, so reinsert only the CSS filtered above.
    const inlineStyles = styles
        .filter(Boolean)
        .map(
            (style) =>
                `<style>${style.replace(/<\/style(?=[\t\n\f\r />])/gi, '\\3c /style')}</style>`
        )
        .join('');
    const inlineScripts = scripts
        .filter(Boolean)
        .map((script) => `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`)
        .join('');
    return `${inlineStyles}${sanitized}${inlineScripts}`;
}

export function createArtifactSrcdoc(
    source: string,
    nonce: string,
    theme: VisualReplyThemeSnapshot = createVisualReplyThemeSnapshot()
): string {
    if (!/^[a-z\d-]{1,128}$/i.test(nonce)) {
        throw new Error('Artifact nonce must use a bounded alphanumeric format.');
    }

    const sanitized = sanitizeArtifactHtml(source);
    const themeProperties = serializeVisualReplyTheme(theme);
    const themeTokens = JSON.stringify(VISUAL_REPLY_THEME_TOKEN_NAMES);
    const bridgeScript = `
      (() => {
        const send = (type, value) => parent.postMessage({ channel: 'touchai-visual-reply', nonce: ${JSON.stringify(nonce)}, type, value }, '*');
        const themeTokens = ${themeTokens};
        const applyTheme = snapshot => {
          if (!snapshot || typeof snapshot !== 'object') return;
          for (const token of themeTokens) {
            const value = snapshot[token];
            if (typeof value === 'string' && value) {
              document.documentElement.style.setProperty(token, value);
            }
          }
        };
        addEventListener('message', event => {
          const message = event.data;
          if (event.source !== parent || !message || message.channel !== 'touchai-visual-reply' || message.nonce !== ${JSON.stringify(nonce)} || message.type !== 'theme') return;
          applyTheme(message.value);
        });
        let resizeFrame = 0;
        const resize = () => {
          if (resizeFrame) return;
          resizeFrame = requestAnimationFrame(() => {
            resizeFrame = 0;
            send('resize', Math.min(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), 1200));
          });
        };
        new ResizeObserver(resize).observe(document.documentElement);
        addEventListener('error', event => send('error', String(event.message || 'Artifact script failed').slice(0, 300)));
        addEventListener('unhandledrejection', event => send('error', String(event.reason?.message || event.reason || 'Artifact script rejected').slice(0, 300)));
        addEventListener('load', resize);
        addEventListener('load', () => send('ready', true), { once: true });
        setTimeout(() => { resize(); send('ready', true); }, 0);
      })();
    `;

    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>:root{${themeProperties}}html,body{margin:0;width:100%;min-height:0;overflow:hidden;font:14px var(--touchai-font-sans,system-ui,sans-serif);color:var(--touchai-color-text-primary,#4a4039)}*{box-sizing:border-box}body{padding:4px}img,svg,canvas{max-width:100%}button,a,input,select,textarea{font:inherit}</style></head><body><script>${bridgeScript}</script>${sanitized}</body></html>`;
}

export type VisualReplyBridgeMessage =
    | {
          channel: 'touchai-visual-reply';
          nonce: string;
          type: 'resize';
          value: number;
      }
    | {
          channel: 'touchai-visual-reply';
          nonce: string;
          type: 'ready';
          value: true;
      }
    | {
          channel: 'touchai-visual-reply';
          nonce: string;
          type: 'error';
          value: string;
      };

export function isVisualReplyBridgeMessage(value: unknown): value is VisualReplyBridgeMessage {
    if (!value || typeof value !== 'object') return false;
    const message = value as Record<string, unknown>;
    const validValue =
        (message.type === 'resize' &&
            typeof message.value === 'number' &&
            Number.isFinite(message.value)) ||
        (message.type === 'ready' && message.value === true) ||
        (message.type === 'error' &&
            typeof message.value === 'string' &&
            message.value.length <= 300);
    return (
        message.channel === 'touchai-visual-reply' &&
        typeof message.nonce === 'string' &&
        message.nonce.length > 0 &&
        message.nonce.length <= 128 &&
        validValue
    );
}
