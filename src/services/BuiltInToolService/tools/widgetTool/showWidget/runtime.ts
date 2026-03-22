// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type morphdom from 'morphdom';

import {
    SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS,
    SHOW_WIDGET_COLOR_RAMPS,
    SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS,
    SHOW_WIDGET_FADE_IN_ANIMATION,
    SHOW_WIDGET_THEME_FALLBACKS,
} from './runtimeConstants';

/**
 * ShowWidget 在回答流里直接渲染原生 DOM 片段。
 *
 * 这个版本刻意保持轻量：
 * - 依赖 morphdom 做增量更新
 * - 支持流式草稿、主题变量和脚本执行
 * - 用最小布局保护避免 widget 破坏消息区宽度
 */

export { SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS, SHOW_WIDGET_TOOL_NAME } from './runtimeConstants';

export type ShowWidgetMode = 'render' | 'remove';
export type ShowWidgetPhase = 'draft' | 'ready';

export interface ShowWidgetPayload {
    callId: string;
    widgetId: string;
    title: string;
    description: string;
    html: string;
    mode: ShowWidgetMode;
    phase: ShowWidgetPhase;
}

export interface ShowWidgetDraft {
    widgetId?: string;
    title?: string;
    description?: string;
    html?: string;
    mode?: ShowWidgetMode;
}

export interface WidgetRenderer {
    render(payload: ShowWidgetRenderPayload): void;
    destroy(): void;
}

type MorphdomFunction = typeof morphdom;
type ShowWidgetRenderPayload = Pick<
    ShowWidgetPayload,
    'widgetId' | 'title' | 'description' | 'html' | 'phase'
>;

interface ParsedRenderTree {
    fragment: DocumentFragment;
}

interface ShowWidgetRendererState {
    destroyed: boolean;
    lastExecutedHtml: string;
    morphdomImpl: MorphdomFunction | null;
    morphdomPromise: Promise<MorphdomFunction> | null;
    pendingPayload: ShowWidgetRenderPayload | null;
    applyTimer: number | null;
    lastDraftAppliedAt: number;
    hasAppliedMeaningfulDraft: boolean;
    scriptRunToken: number;
}

interface ShowWidgetTypographySource {
    fontFamily: string;
    fontWeight: string;
}

declare global {
    interface Window {
        sendPrompt?: (text: string) => void;
        openLink?: (url: string) => void;
    }
}

let morphdomLoader: Promise<MorphdomFunction> | null = null;

/**
 * 增量预览依赖 provider 的 partial JSON。
 *
 * 这里不追求“完整 JSON 修复”，而是只提取 ShowWidget 的关键字符串字段，
 * 从而在工具参数尚未闭合时也能尽早生成可见草稿。
 */
function readPartialJsonStringField(buffer: string, fieldName: string): string | undefined {
    const marker = `"${fieldName}"`;
    const markerIndex = buffer.indexOf(marker);
    if (markerIndex < 0) {
        return undefined;
    }

    const colonIndex = buffer.indexOf(':', markerIndex + marker.length);
    if (colonIndex < 0) {
        return undefined;
    }

    let cursor = colonIndex + 1;
    while (cursor < buffer.length && /\s/.test(buffer[cursor]!)) {
        cursor += 1;
    }

    if (buffer[cursor] !== '"') {
        return undefined;
    }

    cursor += 1;
    let value = '';
    let escaping = false;

    while (cursor < buffer.length) {
        const char = buffer[cursor]!;
        cursor += 1;

        if (escaping) {
            if (char === 'u') {
                const unicode = buffer.slice(cursor, cursor + 4);
                if (/^[0-9a-fA-F]{4}$/.test(unicode)) {
                    value += String.fromCharCode(Number.parseInt(unicode, 16));
                    cursor += 4;
                } else {
                    value += '\\u';
                }
            } else if (char === 'n') {
                value += '\n';
            } else if (char === 'r') {
                value += '\r';
            } else if (char === 't') {
                value += '\t';
            } else {
                value += char;
            }

            escaping = false;
            continue;
        }

        if (char === '\\') {
            escaping = true;
            continue;
        }

        if (char === '"') {
            return value;
        }

        value += char;
    }

    return value;
}

function readPartialJsonEnumField<T extends readonly string[]>(
    buffer: string,
    fieldName: string,
    allowedValues: T
): T[number] | undefined {
    const rawValue = readPartialJsonStringField(buffer, fieldName);
    if (!rawValue || !allowedValues.includes(rawValue as T[number])) {
        return undefined;
    }

    return rawValue as T[number];
}

/**
 * 从仍在流式生成的工具参数里提取 ShowWidget 草稿。
 *
 * @param callId 工具调用 id。
 * @param argumentsBuffer provider 当前已经输出的参数缓冲。
 * @returns 可立即渲染的 draft payload；如果还没有任何关键信息则返回 `null`。
 */
export function buildShowWidgetDraftFromArgumentsBuffer(
    callId: string,
    argumentsBuffer: string
): ShowWidgetPayload | null {
    const widgetCode =
        readPartialJsonStringField(argumentsBuffer, 'widget_code') ??
        readPartialJsonStringField(argumentsBuffer, 'html');
    const draft: ShowWidgetDraft = {
        mode: readPartialJsonEnumField(argumentsBuffer, 'mode', ['render', 'remove'] as const),
        widgetId: readPartialJsonStringField(argumentsBuffer, 'widgetId'),
        title: readPartialJsonStringField(argumentsBuffer, 'title'),
        description: readPartialJsonStringField(argumentsBuffer, 'description'),
        html: widgetCode,
    };

    if (!draft.widgetId && !draft.title && !draft.html) {
        return null;
    }

    return {
        callId,
        widgetId: draft.widgetId || callId,
        title: draft.title || draft.widgetId || '生成中的可视化',
        description: draft.description || '模型正在按已加载规范流式生成内联可视化内容。',
        html: draft.html || '',
        mode: draft.mode || 'render',
        phase: 'draft',
    };
}

/**
 * 检查 widget 使用的外部资源 URL 是否仍在 CDN 白名单内。
 *
 * @param resourceUrl 资源地址。
 * @returns `true` 表示允许加载；空串和非 http(s) URL 视为本地/内联资源。
 */
export function isShowWidgetResourceUrlAllowed(resourceUrl: string): boolean {
    if (!resourceUrl.trim()) {
        return true;
    }

    try {
        const parsedUrl = new URL(
            resourceUrl,
            typeof window === 'undefined' ? 'https://claude.ai/' : window.location.href
        );
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return true;
        }

        return SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS.includes(
            parsedUrl.hostname as (typeof SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS)[number]
        );
    } catch {
        return false;
    }
}

function loadMorphdom(): Promise<MorphdomFunction> {
    if (!morphdomLoader) {
        morphdomLoader = import('morphdom').then((module) => module.default);
    }

    return morphdomLoader;
}

function buildColorRampCss(hostSelector: string): string {
    return Object.entries(SHOW_WIDGET_COLOR_RAMPS)
        .map(([rampName, rampStops]) => {
            const baseSelector = `${hostSelector} .c-${rampName}`;
            return [
                `${baseSelector} > rect,`,
                `${baseSelector} > circle,`,
                `${baseSelector} > ellipse,`,
                `${baseSelector} > polygon { fill: ${rampStops[50]}; stroke: ${rampStops[600]}; stroke-width: 0.5px; }`,
                `${baseSelector} > .t,`,
                `${baseSelector} > .th { fill: ${rampStops[800]}; }`,
                `${baseSelector} > .ts { fill: ${rampStops[600]}; }`,
                `@media (prefers-color-scheme: dark) {`,
                `  ${baseSelector} > rect,`,
                `  ${baseSelector} > circle,`,
                `  ${baseSelector} > ellipse,`,
                `  ${baseSelector} > polygon { fill: ${rampStops[800]}; stroke: ${rampStops[200]}; }`,
                `  ${baseSelector} > .t,`,
                `  ${baseSelector} > .th { fill: ${rampStops[100]}; }`,
                `  ${baseSelector} > .ts { fill: ${rampStops[200]}; }`,
                `}`,
            ].join('\n');
        })
        .join('\n');
}

function readThemeFontVariable(variableName: '--font-serif' | '--font-mono'): string {
    return (
        getComputedStyle(document.documentElement).getPropertyValue(variableName).trim() ||
        SHOW_WIDGET_THEME_FALLBACKS[variableName]
    );
}

/**
 * 上游 prompt 假定宿主已经注入了一套基础视觉令牌和 SVG 预置类。
 *
 * TouchAI 没有原生 widget host，因此这里补一层最小兼容样式，
 * 让 `t/ts/th/box/c-*` 等类名、基础表单控件和主题变量都能直接工作。
 *
 * @param hostSelector 当前 widget host 的 CSS 选择器。
 * @returns 绑定到当前 host 的基础样式字符串。
 */
export function createShowWidgetBaseStyles(hostSelector: string): string {
    return [
        `${hostSelector} {`,
        `  --touchai-widget-font-body: var(--font-serif);`,
        `  display: block;`,
        `  width: 100%;`,
        `  max-width: 100%;`,
        `  min-width: 0;`,
        `  position: relative;`,
        `  overflow: hidden;`,
        `  isolation: isolate;`,
        `  contain: layout paint style;`,
        `  color: var(--color-text-primary);`,
        `  font-family: var(--touchai-widget-font-body), system-ui, sans-serif;`,
        `  line-height: 1.5;`,
        `  background: transparent;`,
        `}`,
        `${hostSelector} *, ${hostSelector} *::before, ${hostSelector} *::after { box-sizing: border-box; }`,
        `${hostSelector} > * { max-width: 100%; min-width: 0; }`,
        `${hostSelector} [data-touchai-widget-root="true"] { width: 100%; max-width: 100%; min-width: 0; overflow: hidden; }`,
        `${hostSelector} [data-touchai-widget-root="true"] > * { max-width: 100%; min-width: 0; }`,
        `${hostSelector} svg { display: block; width: 100%; max-width: 100%; height: auto; overflow: hidden; }`,
        `${hostSelector} img, ${hostSelector} canvas, ${hostSelector} video { display: block; max-width: 100%; height: auto; }`,
        `${hostSelector} pre, ${hostSelector} code { max-width: 100%; overflow-wrap: anywhere; }`,
        `${hostSelector} svg text, ${hostSelector} svg tspan { font-family: var(--touchai-widget-font-body), system-ui, sans-serif; font-weight: 400; }`,
        `${hostSelector} .t { fill: var(--color-text-primary); font-family: var(--touchai-widget-font-body), system-ui, sans-serif; font-size: 14px; font-weight: 400; }`,
        `${hostSelector} .ts { fill: var(--color-text-secondary); font-family: var(--touchai-widget-font-body), system-ui, sans-serif; font-size: 12px; font-weight: 400; }`,
        `${hostSelector} .th { fill: var(--color-text-primary); font-family: var(--touchai-widget-font-body), system-ui, sans-serif; font-size: 14px; font-weight: 500; }`,
        `${hostSelector} .box { fill: var(--color-background-secondary); stroke: var(--color-border-tertiary); stroke-width: 0.5px; }`,
        `${hostSelector} .node { cursor: pointer; transition: opacity 120ms ease; }`,
        `${hostSelector} .node:hover { opacity: 0.88; }`,
        `${hostSelector} .arr { fill: none; stroke: var(--color-border-primary); stroke-width: 1.5px; stroke-linecap: round; stroke-linejoin: round; marker-end: url(#arrow); }`,
        `${hostSelector} .leader { fill: none; stroke: var(--color-border-tertiary); stroke-width: 0.5px; stroke-dasharray: 4 4; }`,
        `${hostSelector} { --p: var(--color-text-primary); --s: var(--color-text-secondary); --t: var(--color-text-tertiary); --bg2: var(--color-background-secondary); --b: var(--color-border-tertiary); }`,
        `${hostSelector} [data-touchai-widget-added="true"] { animation: ${SHOW_WIDGET_FADE_IN_ANIMATION}; }`,
        `@keyframes touchai-widget-fade-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: translateY(0); } }`,
        buildColorRampCss(hostSelector),
        `${hostSelector} *::-webkit-scrollbar { width: 6px; height: 6px; }`,
        `${hostSelector} *::-webkit-scrollbar-track { background: transparent; }`,
        `${hostSelector} *::-webkit-scrollbar-thumb { background: var(--color-scrollbar-thumb); border-radius: 3px; transition: background 0.2s; }`,
        `${hostSelector} *::-webkit-scrollbar-thumb:hover { background: var(--color-scrollbar-thumb-hover); }`,
        `${hostSelector} *::-webkit-scrollbar-button { display: none; width: 0; height: 0; }`,
        `${hostSelector} a { color: var(--color-text-info); text-decoration: none; transition: opacity 0.2s; }`,
        `${hostSelector} a:hover { opacity: 0.8; text-decoration: underline; }`,
        `${hostSelector} code { font-family: var(--font-mono); font-size: 0.9em; background: var(--color-background-secondary); padding: 0.2em 0.4em; border-radius: 3px; color: var(--color-text-primary); }`,
        `${hostSelector} pre { font-family: var(--font-mono); font-size: 13px; background: var(--color-background-secondary); padding: 1rem; border-radius: var(--border-radius-md); overflow-x: auto; color: var(--color-text-primary); }`,
        `${hostSelector} pre code { background: none; padding: 0; }`,
        `${hostSelector} input[type="text"],`,
        `${hostSelector} input[type="number"],`,
        `${hostSelector} input[type="email"],`,
        `${hostSelector} input[type="password"],`,
        `${hostSelector} input[type="search"],`,
        `${hostSelector} input[type="url"],`,
        `${hostSelector} input[type="tel"],`,
        `${hostSelector} textarea {`,
        `  width: 100%;`,
        `  min-height: 36px;`,
        `  background: var(--color-background-primary);`,
        `  border: 1px solid var(--color-border-tertiary);`,
        `  border-radius: var(--border-radius-md);`,
        `  color: var(--color-text-primary);`,
        `  padding: 0.45rem 0.75rem;`,
        `  font-size: 14px;`,
        `  font-family: var(--font-sans);`,
        `  outline: none;`,
        `  transition: border-color 0.2s, box-shadow 0.2s;`,
        `}`,
        `${hostSelector} input[type="text"]:hover,`,
        `${hostSelector} input[type="number"]:hover,`,
        `${hostSelector} input[type="email"]:hover,`,
        `${hostSelector} input[type="password"]:hover,`,
        `${hostSelector} input[type="search"]:hover,`,
        `${hostSelector} input[type="url"]:hover,`,
        `${hostSelector} input[type="tel"]:hover,`,
        `${hostSelector} textarea:hover { border-color: var(--color-border-secondary); }`,
        `${hostSelector} input[type="text"]:focus,`,
        `${hostSelector} input[type="number"]:focus,`,
        `${hostSelector} input[type="email"]:focus,`,
        `${hostSelector} input[type="password"]:focus,`,
        `${hostSelector} input[type="search"]:focus,`,
        `${hostSelector} input[type="url"]:focus,`,
        `${hostSelector} input[type="tel"]:focus,`,
        `${hostSelector} textarea:focus { border-color: var(--color-border-primary); box-shadow: 0 0 0 2px rgba(156, 163, 175, 0.1); }`,
        `${hostSelector} textarea { min-height: 80px; resize: vertical; }`,
        `${hostSelector} select {`,
        `  width: 100%;`,
        `  min-height: 36px;`,
        `  background: var(--color-background-primary);`,
        `  border: 1px solid var(--color-border-tertiary);`,
        `  border-radius: var(--border-radius-md);`,
        `  color: var(--color-text-primary);`,
        `  padding: 0.45rem 2rem 0.45rem 0.75rem;`,
        `  font-size: 14px;`,
        `  font-family: var(--font-sans);`,
        `  outline: none;`,
        `  cursor: pointer;`,
        `  transition: border-color 0.2s, box-shadow 0.2s;`,
        `  appearance: none;`,
        `  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L2 4h8z'/%3E%3C/svg%3E");`,
        `  background-repeat: no-repeat;`,
        `  background-position: right 0.75rem center;`,
        `  background-size: 12px;`,
        `}`,
        `${hostSelector} select:hover { border-color: var(--color-border-secondary); }`,
        `${hostSelector} select:focus { border-color: var(--color-border-primary); box-shadow: 0 0 0 2px rgba(156, 163, 175, 0.1); }`,
        `${hostSelector} button {`,
        `  background: transparent;`,
        `  border: 1px solid var(--color-border-secondary);`,
        `  border-radius: var(--border-radius-md);`,
        `  color: var(--color-text-primary);`,
        `  padding: 0.5rem 0.85rem;`,
        `  font-size: 14px;`,
        `  font-family: var(--font-sans);`,
        `  cursor: pointer;`,
        `  transition: background-color 0.2s, border-color 0.2s, transform 0.1s;`,
        `  outline: none;`,
        `}`,
        `${hostSelector} button:hover { background: var(--color-background-secondary); border-color: var(--color-border-primary); }`,
        `${hostSelector} button:active { transform: scale(0.98); }`,
        `${hostSelector} button:focus-visible { box-shadow: 0 0 0 2px rgba(156, 163, 175, 0.2); }`,
        `${hostSelector} button:disabled { opacity: 0.5; cursor: not-allowed; }`,
        `${hostSelector} input[type="range"] { width: 100%; height: 4px; background: var(--color-border-secondary); border-radius: 2px; outline: none; appearance: none; -webkit-appearance: none; }`,
        `${hostSelector} input[type="range"]::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: var(--color-text-primary); cursor: pointer; transition: transform 0.2s; }`,
        `${hostSelector} input[type="range"]::-webkit-slider-thumb:hover { transform: scale(1.1); }`,
        `${hostSelector} input[type="range"]::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: var(--color-text-primary); cursor: pointer; border: none; transition: transform 0.2s; }`,
        `${hostSelector} input[type="range"]::-moz-range-thumb:hover { transform: scale(1.1); }`,
        `${hostSelector} input[type="checkbox"], ${hostSelector} input[type="radio"] { width: 16px; height: 16px; border: 1px solid var(--color-border-secondary); border-radius: 3px; background: var(--color-background-primary); cursor: pointer; appearance: none; -webkit-appearance: none; transition: background 0.2s, border-color 0.2s; }`,
        `${hostSelector} input[type="radio"] { border-radius: 50%; }`,
        `${hostSelector} input[type="checkbox"]:checked, ${hostSelector} input[type="radio"]:checked { background: var(--color-text-info); border-color: var(--color-text-info); }`,
        `${hostSelector} input[type="checkbox"]:checked::after { content: ''; display: block; width: 4px; height: 8px; border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg) translate(-50%, -50%); position: relative; left: 50%; top: 40%; }`,
        `${hostSelector} input[type="radio"]:checked::after { content: ''; display: block; width: 8px; height: 8px; border-radius: 50%; background: white; position: relative; left: 50%; top: 50%; transform: translate(-50%, -50%); }`,
        `${hostSelector} table { width: 100%; border-collapse: collapse; font-size: 14px; table-layout: fixed; }`,
        `${hostSelector} th, ${hostSelector} td { padding: 0.75rem; text-align: left; border-bottom: 1px solid var(--color-border-tertiary); }`,
        `${hostSelector} th { font-weight: 500; color: var(--color-text-primary); background: var(--color-background-secondary); }`,
        `${hostSelector} td { color: var(--color-text-secondary); }`,
        `${hostSelector} tr:hover td { background: var(--color-background-secondary); }`,
    ].join('\n');
}

/**
 * ShowWidget 是回答流里的内联组件，字体应优先跟随当前消息正文的实际排版，
 * 而不是退回到 body 上的系统 UI fallback。
 */
function resolveShowWidgetTypographySource(hostElement: HTMLElement): ShowWidgetTypographySource {
    const messageContainer = hostElement.closest('.ai-message');
    const markdownAnchor = messageContainer?.querySelector<HTMLElement>('.touchai-markdown');
    const reasoningAnchor = messageContainer?.querySelector<HTMLElement>('.reasoning-content');
    const typographyAnchor = markdownAnchor || reasoningAnchor;
    const computed = typographyAnchor ? getComputedStyle(typographyAnchor) : null;
    const defaultBodyFontFamily = readThemeFontVariable('--font-serif');

    return {
        fontFamily:
            computed?.fontFamily.trim() ||
            defaultBodyFontFamily ||
            SHOW_WIDGET_THEME_FALLBACKS['--font-serif'] ||
            SHOW_WIDGET_THEME_FALLBACKS['--font-sans'],
        fontWeight: computed?.fontWeight.trim() || '400',
    };
}

function ensureShowWidgetThemeVariables(hostElement: HTMLElement): void {
    const documentStyle = getComputedStyle(document.documentElement);
    const typographySource = resolveShowWidgetTypographySource(hostElement);

    for (const [variableName, fallbackValue] of Object.entries(SHOW_WIDGET_THEME_FALLBACKS)) {
        if (variableName === '--font-sans' || variableName === '--font-serif') {
            hostElement.style.setProperty(variableName, typographySource.fontFamily);
            continue;
        }

        if (variableName === '--font-mono') {
            const monoFont =
                documentStyle.getPropertyValue(variableName).trim() ||
                fallbackValue ||
                readThemeFontVariable('--font-mono');
            hostElement.style.setProperty(variableName, monoFont);
            continue;
        }

        const resolvedValue =
            documentStyle.getPropertyValue(variableName).trim() ||
            hostElement.style.getPropertyValue(variableName).trim() ||
            fallbackValue;
        hostElement.style.setProperty(variableName, resolvedValue);
    }

    hostElement.style.setProperty('--touchai-widget-font-body', typographySource.fontFamily);
    hostElement.style.fontFamily = typographySource.fontFamily;
    hostElement.style.fontWeight = typographySource.fontWeight;
}

/**
 * 流式渲染时 `<style>` / `<script>` 可能只输出了开始标签。
 *
 * 浏览器会把这些未闭合片段当成普通文本渲染出来，因此草稿阶段只保留已经完整闭合的块，
 * 避免把大段 CSS/JS 原样暴露到消息里。
 */
function sanitizeDraftHtml(html: string, phase: ShowWidgetPhase): string {
    if (phase === 'ready') {
        return html;
    }

    let sanitized = html;

    const lastStyleOpenIndex = sanitized.lastIndexOf('<style');
    if (lastStyleOpenIndex !== -1) {
        const afterStyleOpen = sanitized.slice(lastStyleOpenIndex);
        if (!afterStyleOpen.includes('</style>')) {
            sanitized = sanitized.slice(0, lastStyleOpenIndex);
        }
    }

    const lastScriptOpenIndex = sanitized.lastIndexOf('<script');
    if (lastScriptOpenIndex !== -1) {
        const afterScriptOpen = sanitized.slice(lastScriptOpenIndex);
        if (!afterScriptOpen.includes('</script>')) {
            sanitized = sanitized.slice(0, lastScriptOpenIndex);
        }
    }

    return sanitized.trim();
}

function parseRenderTree(rawHtml: string, phase: ShowWidgetPhase = 'ready'): ParsedRenderTree {
    const template = document.createElement('template');
    const sanitizedHtml = sanitizeDraftHtml(rawHtml, phase);
    const normalizedHtml = sanitizedHtml || '<div></div>';
    const isFullDocument = /<(?:!doctype|html|head|body)\b/i.test(normalizedHtml);

    if (isFullDocument) {
        const parser = new DOMParser();
        const parsed = parser.parseFromString(normalizedHtml, 'text/html');
        template.innerHTML = parsed.body.innerHTML || '<div></div>';
    } else {
        template.innerHTML = normalizedHtml;
        if (!template.content.childNodes.length) {
            template.innerHTML = '<div></div>';
        }
    }

    return {
        fragment: template.content,
    };
}

function hasMeaningfulContent(fragment: DocumentFragment): boolean {
    const walker = document.createTreeWalker(
        fragment,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
    );
    let currentNode = walker.nextNode();

    while (currentNode) {
        if (currentNode.nodeType === Node.TEXT_NODE && currentNode.textContent?.trim()) {
            return true;
        }

        if (currentNode.nodeType === Node.ELEMENT_NODE) {
            const tagName = (currentNode as Element).tagName;
            if (!['STYLE', 'SCRIPT', 'META', 'LINK', 'TITLE'].includes(tagName)) {
                return true;
            }
        }

        currentNode = walker.nextNode();
    }

    return false;
}

function getNodeKey(node: Node): string | null {
    if (!(node instanceof Element)) {
        return null;
    }

    return node.getAttribute('data-widget-key') || node.id || null;
}

function applyNodeAddedAnimation(node: Node): void {
    if (!(node instanceof HTMLElement || node instanceof SVGElement)) {
        return;
    }

    const tagName = node.tagName.toUpperCase();
    if (['SCRIPT', 'STYLE', 'META', 'LINK'].includes(tagName)) {
        return;
    }

    node.setAttribute('data-touchai-widget-added', 'true');
    node.addEventListener(
        'animationend',
        () => {
            node.removeAttribute('data-touchai-widget-added');
        },
        { once: true }
    );
}

function copyScriptAttributes(source: HTMLScriptElement, target: HTMLScriptElement): void {
    for (const attribute of Array.from(source.attributes)) {
        if (attribute.name === 'src') {
            continue;
        }

        target.setAttribute(attribute.name, attribute.value);
    }

    if (source.src) {
        target.async = false;
        target.src = source.src;
    } else {
        target.textContent = source.textContent;
    }
}

/**
 * 简化后的脚本执行策略直接重新插入 `<script>` 节点。
 *
 * 这样和浏览器原生行为一致，也避免沙箱代理破坏常见第三方库或 DOM 访问方式。
 */
async function runInlineScripts(
    root: HTMLElement,
    htmlSignature: string,
    state: ShowWidgetRendererState
): Promise<void> {
    if (htmlSignature === state.lastExecutedHtml) {
        return;
    }

    state.lastExecutedHtml = htmlSignature;
    const runToken = ++state.scriptRunToken;
    const scripts = Array.from(root.querySelectorAll('script'));

    for (const oldNode of scripts) {
        if (state.destroyed || runToken !== state.scriptRunToken) {
            return;
        }

        if (oldNode.src && !isShowWidgetResourceUrlAllowed(oldNode.src)) {
            oldNode.remove();
            continue;
        }

        const newNode = document.createElement('script');
        copyScriptAttributes(oldNode, newNode);
        const parent = oldNode.parentNode;

        if (!parent) {
            continue;
        }

        if (oldNode.src) {
            await new Promise<void>((resolve) => {
                newNode.addEventListener('load', () => resolve(), { once: true });
                newNode.addEventListener('error', () => resolve(), { once: true });
                parent.replaceChild(newNode, oldNode);
            });
            continue;
        }

        parent.replaceChild(newNode, oldNode);
    }
}

function applyShowWidgetLayoutGuards(hostElement: HTMLElement, widgetRoot: HTMLElement): void {
    hostElement.style.width = '100%';
    hostElement.style.maxWidth = '100%';
    hostElement.style.minWidth = '0';
    hostElement.style.overflow = 'hidden';

    widgetRoot.style.width = '100%';
    widgetRoot.style.maxWidth = '100%';
    widgetRoot.style.minWidth = '0';
    widgetRoot.style.overflow = 'hidden';

    // Widget 常常会生成 svg/img/canvas/video 作为第一层内容，这里统一补一层宽度约束，
    // 避免媒体元素在没有内联样式时撑破消息列。
    for (const mediaElement of widgetRoot.querySelectorAll<HTMLElement>(
        'svg, img, canvas, video'
    )) {
        if (mediaElement.tagName === 'SVG') {
            mediaElement.style.width = '100%';
        }

        mediaElement.style.maxWidth = '100%';
    }
}

function openShowWidgetLink(url: string): void {
    if (!url.trim()) {
        return;
    }

    if (typeof window.openLink === 'function') {
        window.openLink(url);
        return;
    }

    window.open(url, '_blank');
}

function morphWidgetRoot(
    root: HTMLElement,
    nextRoot: HTMLElement,
    morphdomImpl: MorphdomFunction
): void {
    morphdomImpl(root, nextRoot, {
        childrenOnly: true,
        getNodeKey,
        onBeforeElUpdated(fromEl, toEl) {
            return !fromEl.isEqualNode(toEl);
        },
        onNodeAdded(node) {
            applyNodeAddedAnimation(node);
        },
    });
}

async function applyDocumentHtml(
    hostElement: HTMLElement,
    root: HTMLElement,
    rawHtml: string,
    phase: ShowWidgetPhase,
    state: ShowWidgetRendererState
): Promise<boolean> {
    const morphdomImpl = state.morphdomImpl;
    if (!morphdomImpl) {
        return false;
    }

    const parsedTree = parseRenderTree(rawHtml, phase);
    if (phase !== 'ready' && !hasMeaningfulContent(parsedTree.fragment)) {
        return false;
    }

    const nextRoot = document.createElement('div');
    nextRoot.appendChild(parsedTree.fragment);
    morphWidgetRoot(root, nextRoot, morphdomImpl);
    applyShowWidgetLayoutGuards(hostElement, root);

    if (phase === 'ready') {
        await runInlineScripts(root, rawHtml || '', state);
        applyShowWidgetLayoutGuards(hostElement, root);
    }

    return true;
}

function clearApplyTimer(state: ShowWidgetRendererState): void {
    if (state.applyTimer !== null) {
        window.clearTimeout(state.applyTimer);
        state.applyTimer = null;
    }
}

/**
 * 创建会话内 widget 的内联渲染器。
 *
 * @param hostElement 实际承载 widget 的宿主节点。
 * @returns 负责渲染/销毁 widget 的轻量 renderer。
 */
export function createWidgetRenderer(hostElement: HTMLElement): WidgetRenderer {
    const scopeId = `touchai-widget-${crypto.randomUUID()}`;
    const hostSelector = `[data-touchai-widget-host="${scopeId}"]`;
    const state: ShowWidgetRendererState = {
        destroyed: false,
        lastExecutedHtml: '',
        morphdomImpl: null,
        morphdomPromise: null,
        pendingPayload: null,
        applyTimer: null,
        lastDraftAppliedAt: 0,
        hasAppliedMeaningfulDraft: false,
        scriptRunToken: 0,
    };

    hostElement.dataset.touchaiWidgetHost = scopeId;
    hostElement.dataset.widgetPhase = 'draft';
    ensureShowWidgetThemeVariables(hostElement);

    const baseStyleElement = document.createElement('style');
    baseStyleElement.setAttribute('data-touchai-widget-base-style', 'true');
    baseStyleElement.textContent = createShowWidgetBaseStyles(hostSelector);

    const widgetRoot = document.createElement('div');
    widgetRoot.setAttribute('data-touchai-widget-root', 'true');
    hostElement.replaceChildren(baseStyleElement, widgetRoot);
    applyShowWidgetLayoutGuards(hostElement, widgetRoot);

    const flushPendingPayload = (): void => {
        if (state.destroyed || !state.pendingPayload) {
            return;
        }

        if (!state.morphdomImpl) {
            ensureMorphdomReady();
            return;
        }

        const payload = state.pendingPayload;
        state.pendingPayload = null;
        void applyDocumentHtml(hostElement, widgetRoot, payload.html, payload.phase, state).then(
            (didApply) => {
                if (payload.phase === 'draft' && didApply) {
                    state.lastDraftAppliedAt = Date.now();
                    state.hasAppliedMeaningfulDraft = true;
                }
            }
        );
    };

    const ensureMorphdomReady = (): void => {
        if (state.morphdomImpl || state.morphdomPromise || state.destroyed) {
            return;
        }

        state.morphdomPromise = loadMorphdom()
            .then((loadedMorphdom) => {
                if (state.destroyed) {
                    return loadedMorphdom;
                }

                state.morphdomImpl = loadedMorphdom;
                state.morphdomPromise = null;
                const shouldFlushImmediately =
                    state.pendingPayload?.phase === 'ready' || state.applyTimer === null;
                if (shouldFlushImmediately) {
                    flushPendingPayload();
                }
                return loadedMorphdom;
            })
            .catch((error) => {
                state.morphdomPromise = null;
                console.error('[ShowWidget] Failed to load morphdom:', error);
                throw error;
            });
    };

    const schedulePayloadFlush = (payload: ShowWidgetRenderPayload): void => {
        state.pendingPayload = payload;
        ensureMorphdomReady();

        if (payload.phase === 'ready') {
            clearApplyTimer(state);
            flushPendingPayload();
            return;
        }

        // 首个真正有内容的草稿直接落地，确保用户尽快看到结构骨架。
        if (!state.hasAppliedMeaningfulDraft && payload.html.trim()) {
            clearApplyTimer(state);
            flushPendingPayload();
            return;
        }

        if (state.applyTimer !== null) {
            return;
        }

        const elapsed = state.lastDraftAppliedAt > 0 ? Date.now() - state.lastDraftAppliedAt : 0;
        const delay = Math.max(0, SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS - elapsed);

        state.applyTimer = window.setTimeout(() => {
            state.applyTimer = null;
            flushPendingPayload();
        }, delay);
    };

    ensureMorphdomReady();

    const handleHostClick = (event: MouseEvent): void => {
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest('a');
        const href = anchor?.getAttribute('href')?.trim();

        if (!anchor || !href || href === '#' || href.startsWith('#')) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        openShowWidgetLink(href);
    };

    hostElement.addEventListener('click', handleHostClick, true);

    return {
        render(payload) {
            hostElement.dataset.widgetPhase = payload.phase;
            hostElement.dataset.widgetId = payload.widgetId;
            hostElement.title = payload.title;
            hostElement.setAttribute(
                'aria-label',
                payload.title || payload.description || 'ShowWidget'
            );
            applyShowWidgetLayoutGuards(hostElement, widgetRoot);
            schedulePayloadFlush(payload);
        },
        destroy() {
            state.destroyed = true;
            state.scriptRunToken += 1;
            clearApplyTimer(state);
            hostElement.removeEventListener('click', handleHostClick, true);
            hostElement.replaceChildren();
            delete hostElement.dataset.touchaiWidgetHost;
            delete hostElement.dataset.widgetPhase;
            delete hostElement.dataset.widgetId;
            hostElement.removeAttribute('title');
            hostElement.removeAttribute('aria-label');
        },
    };
}
