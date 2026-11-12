// Copyright (c) 2026. 千诚. Licensed under GPL v3

import DOMPurify from 'dompurify';

import { tt } from '@/i18n';

import {
    SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS,
    SHOW_WIDGET_COLOR_RAMPS,
    SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS,
    SHOW_WIDGET_FADE_IN_ANIMATION,
    SHOW_WIDGET_MAX_WIDTH_PX,
    SHOW_WIDGET_THEME_FALLBACKS,
} from './runtimeConstants';
import { createWidgetSandboxDocument } from './sandbox';

/** Generated code runs only inside an opaque-origin sandboxed frame. */

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

const SHOW_WIDGET_CLASSIC_SCRIPT_TYPES = new Set([
    '',
    'application/ecmascript',
    'application/javascript',
    'text/ecmascript',
    'text/javascript',
]);
type ShowWidgetRenderPayload = Pick<
    ShowWidgetPayload,
    'widgetId' | 'title' | 'description' | 'html' | 'phase'
>;

interface ParsedRenderTree {
    fragment: DocumentFragment;
    scripts: WidgetScriptSnapshot[];
}

interface WidgetScriptSnapshot {
    attributes: Array<{ name: string; value: string }>;
    source: string;
    src: string;
    type: string;
}

interface ShowWidgetRendererState {
    destroyed: boolean;
    pendingPayload: ShowWidgetRenderPayload | null;
    applyTimer: number | null;
    lastDraftAppliedAt: number;
    hasAppliedMeaningfulDraft: boolean;
}

interface ShowWidgetTypographySource {
    fontFamily: string;
    fontWeight: string;
}

type SimpleWidgetActionName = 'sendPrompt' | 'openLink';

interface SimpleWidgetAction {
    name: SimpleWidgetActionName;
    value: string;
}

declare global {
    interface Window {
        sendPrompt?: (text: string) => void;
        openLink?: (url: string) => void;
    }
}

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
        title: draft.title || draft.widgetId || tt('生成中的可视化'),
        description: draft.description || tt('模型正在按已加载规范流式生成内联可视化内容。'),
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

function isShowWidgetScriptUrlAllowed(scriptUrl: string): boolean {
    if (!scriptUrl.trim()) {
        return false;
    }

    try {
        const parsedUrl = new URL(
            scriptUrl,
            typeof window === 'undefined' ? 'https://claude.ai/' : window.location.href
        );
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return false;
        }

        return SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS.includes(
            parsedUrl.hostname as (typeof SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS)[number]
        );
    } catch {
        return false;
    }
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
        `  max-width: ${SHOW_WIDGET_MAX_WIDTH_PX}px;`,
        `  min-width: 0;`,
        `  margin-left: auto;`,
        `  margin-right: auto;`,
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
        `${hostSelector} .node { cursor: pointer; transition: opacity var(--touchai-widget-duration-quick) var(--touchai-widget-ease); }`,
        `${hostSelector} .node:hover { opacity: 0.88; }`,
        `${hostSelector} .arr { fill: none; stroke: var(--color-border-primary); stroke-width: 1.5px; stroke-linecap: round; stroke-linejoin: round; marker-end: url(#arrow); }`,
        `${hostSelector} .leader { fill: none; stroke: var(--color-border-tertiary); stroke-width: 0.5px; stroke-dasharray: 4 4; }`,
        `${hostSelector} { --p: var(--color-text-primary); --s: var(--color-text-secondary); --t: var(--color-text-tertiary); --bg2: var(--color-background-secondary); --b: var(--color-border-tertiary); --touchai-widget-duration-quick: 150ms; --touchai-widget-duration-fast: 250ms; --touchai-widget-ease: cubic-bezier(0.22, 1, 0.36, 1); }`,
        `${hostSelector} [data-touchai-widget-added="true"] { animation: ${SHOW_WIDGET_FADE_IN_ANIMATION}; }`,
        `@keyframes touchai-widget-fade-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: translateY(0); } }`,
        `@media (prefers-reduced-motion: reduce) { ${hostSelector} *, ${hostSelector} *::before, ${hostSelector} *::after { animation-duration: 0.01ms !important; animation-delay: 0ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } }`,
        buildColorRampCss(hostSelector),
        `${hostSelector} *::-webkit-scrollbar { width: 6px; height: 6px; }`,
        `${hostSelector} *::-webkit-scrollbar-track { background: transparent; }`,
        `${hostSelector} *::-webkit-scrollbar-thumb { background: var(--color-scrollbar-thumb); border-radius: 3px; transition: background-color var(--touchai-widget-duration-quick) var(--touchai-widget-ease); }`,
        `${hostSelector} *::-webkit-scrollbar-thumb:hover { background: var(--color-scrollbar-thumb-hover); }`,
        `${hostSelector} *::-webkit-scrollbar-button { display: none; width: 0; height: 0; }`,
        `${hostSelector} a { color: var(--color-text-info); text-decoration: none; transition: opacity var(--touchai-widget-duration-quick) var(--touchai-widget-ease); }`,
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
        `  transition: border-color var(--touchai-widget-duration-quick) var(--touchai-widget-ease), outline-color var(--touchai-widget-duration-quick) var(--touchai-widget-ease);`,
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
        `${hostSelector} textarea:focus { border-color: var(--color-border-primary); outline: 2px solid var(--color-border-tertiary); outline-offset: 1px; }`,
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
        `  transition: border-color var(--touchai-widget-duration-quick) var(--touchai-widget-ease), outline-color var(--touchai-widget-duration-quick) var(--touchai-widget-ease);`,
        `  appearance: none;`,
        `  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L2 4h8z'/%3E%3C/svg%3E");`,
        `  background-repeat: no-repeat;`,
        `  background-position: right 0.75rem center;`,
        `  background-size: 12px;`,
        `}`,
        `${hostSelector} select:hover { border-color: var(--color-border-secondary); }`,
        `${hostSelector} select:focus { border-color: var(--color-border-primary); outline: 2px solid var(--color-border-tertiary); outline-offset: 1px; }`,
        `${hostSelector} button {`,
        `  background: transparent;`,
        `  border: 1px solid var(--color-border-secondary);`,
        `  border-radius: var(--border-radius-md);`,
        `  color: var(--color-text-primary);`,
        `  padding: 0.5rem 0.85rem;`,
        `  font-size: 14px;`,
        `  font-family: var(--font-sans);`,
        `  cursor: pointer;`,
        `  transition: background-color var(--touchai-widget-duration-quick) var(--touchai-widget-ease), border-color var(--touchai-widget-duration-quick) var(--touchai-widget-ease), transform var(--touchai-widget-duration-quick) var(--touchai-widget-ease);`,
        `  outline: none;`,
        `}`,
        `${hostSelector} button:hover { background: var(--color-background-secondary); border-color: var(--color-border-primary); }`,
        `${hostSelector} button:active { transform: scale(0.98); }`,
        `${hostSelector} button:focus-visible { outline: 2px solid var(--color-border-tertiary); outline-offset: 1px; }`,
        `${hostSelector} button:disabled { opacity: 0.5; cursor: not-allowed; }`,
        `${hostSelector} input[type="range"] { width: 100%; height: 4px; background: var(--color-border-secondary); border-radius: 2px; outline: none; appearance: none; -webkit-appearance: none; }`,
        `${hostSelector} input[type="range"]::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: var(--color-text-primary); cursor: pointer; transition: transform var(--touchai-widget-duration-quick) var(--touchai-widget-ease); }`,
        `${hostSelector} input[type="range"]::-webkit-slider-thumb:hover { transform: scale(1.1); }`,
        `${hostSelector} input[type="range"]::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: var(--color-text-primary); cursor: pointer; border: none; transition: transform var(--touchai-widget-duration-quick) var(--touchai-widget-ease); }`,
        `${hostSelector} input[type="range"]::-moz-range-thumb:hover { transform: scale(1.1); }`,
        `${hostSelector} input[type="checkbox"], ${hostSelector} input[type="radio"] { width: 16px; height: 16px; border: 1px solid var(--color-border-secondary); border-radius: 3px; background: var(--color-background-primary); cursor: pointer; appearance: none; -webkit-appearance: none; transition: background-color var(--touchai-widget-duration-quick) var(--touchai-widget-ease), border-color var(--touchai-widget-duration-quick) var(--touchai-widget-ease); }`,
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

function decodeSimpleJsStringLiteral(value: string): string {
    let decoded = '';

    for (let index = 0; index < value.length; index += 1) {
        const char = value[index]!;
        if (char !== '\\') {
            decoded += char;
            continue;
        }

        index += 1;
        const escaped = value[index];
        if (!escaped) {
            decoded += '\\';
            break;
        }

        switch (escaped) {
            case 'n':
                decoded += '\n';
                break;
            case 'r':
                decoded += '\r';
                break;
            case 't':
                decoded += '\t';
                break;
            case 'b':
                decoded += '\b';
                break;
            case 'f':
                decoded += '\f';
                break;
            default:
                decoded += escaped;
                break;
        }
    }

    return decoded;
}

function parseSimpleWidgetAction(attributeValue: string | null): SimpleWidgetAction | null {
    if (!attributeValue) {
        return null;
    }

    const match = attributeValue.match(
        /^\s*(sendPrompt|openLink)\(\s*(["'])((?:\\.|(?!\2).)*)\2\s*\)\s*;?\s*$/s
    );
    if (!match) {
        return null;
    }

    const value = decodeSimpleJsStringLiteral(match[3] ?? '').trim();
    if (!value) {
        return null;
    }

    return {
        name: match[1] as SimpleWidgetActionName,
        value,
    };
}

function normalizeWidgetActionAttributesIn(root: ParentNode): void {
    const elements = Array.from(root.querySelectorAll('[onclick]'));

    for (const element of elements) {
        const action = parseSimpleWidgetAction(element.getAttribute('onclick'));
        element.removeAttribute('onclick');

        if (!action) {
            continue;
        }

        if (action.name === 'sendPrompt') {
            element.setAttribute('data-send-prompt', action.value);
        } else {
            element.setAttribute('data-open-link', action.value);
        }
    }
}

function snapshotWidgetScript(scriptElement: HTMLScriptElement): WidgetScriptSnapshot {
    return {
        attributes: Array.from(scriptElement.attributes).map((attribute) => ({
            name: attribute.name,
            value: attribute.value,
        })),
        source: scriptElement.textContent ?? '',
        src: scriptElement.src,
        type: (scriptElement.getAttribute('type') ?? '').trim().toLowerCase(),
    };
}

function extractWidgetScripts(root: ParentNode): WidgetScriptSnapshot[] {
    const scripts = Array.from(root.querySelectorAll('script'));

    for (const script of scripts) {
        script.remove();
    }

    return scripts.map(snapshotWidgetScript);
}

function splitCssSelectorList(selectorList: string): string[] {
    const selectors: string[] = [];
    let current = '';
    let depth = 0;
    let quote: '"' | "'" | null = null;

    for (let index = 0; index < selectorList.length; index += 1) {
        const char = selectorList[index]!;

        if (quote) {
            current += char;
            if (char === '\\') {
                index += 1;
                current += selectorList[index] ?? '';
                continue;
            }
            if (char === quote) {
                quote = null;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            current += char;
            continue;
        }

        if (char === '(' || char === '[') {
            depth += 1;
            current += char;
            continue;
        }

        if (char === ')' || char === ']') {
            depth = Math.max(0, depth - 1);
            current += char;
            continue;
        }

        if (char === ',' && depth === 0) {
            selectors.push(current);
            current = '';
            continue;
        }

        current += char;
    }

    selectors.push(current);
    return selectors;
}

function scopeCssSelector(selector: string, hostSelector: string): string {
    const trimmed = selector.trim();
    if (!trimmed) {
        return '';
    }

    if (trimmed.startsWith(hostSelector)) {
        return trimmed;
    }

    if (trimmed === ':root' || trimmed === 'html' || trimmed === 'body') {
        return hostSelector;
    }

    if (trimmed.startsWith(':host')) {
        return trimmed.replace(/^:host\b/, hostSelector);
    }

    return `${hostSelector} ${trimmed}`;
}

function findCssBlockEnd(css: string, openBraceIndex: number): number {
    let depth = 1;
    let quote: '"' | "'" | null = null;

    for (let index = openBraceIndex + 1; index < css.length; index += 1) {
        const char = css[index]!;

        if (quote) {
            if (char === '\\') {
                index += 1;
                continue;
            }
            if (char === quote) {
                quote = null;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (char === '{') {
            depth += 1;
            continue;
        }

        if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }

    return -1;
}

function findNextCssStatementEnd(css: string, startIndex: number): number {
    const nextSemicolon = css.indexOf(';', startIndex);
    const nextBrace = css.indexOf('{', startIndex);

    if (nextSemicolon === -1) {
        return nextBrace === -1 ? css.length : nextBrace;
    }

    if (nextBrace === -1) {
        return nextSemicolon;
    }

    return Math.min(nextSemicolon, nextBrace);
}

function scopeWidgetCss(css: string, hostSelector: string): string {
    let output = '';
    let cursor = 0;

    while (cursor < css.length) {
        const nextBrace = css.indexOf('{', cursor);
        if (nextBrace === -1) {
            const remainder = css.slice(cursor);
            output += remainder.replace(/@import[^;]*;/gi, '');
            break;
        }

        const prelude = css.slice(cursor, nextBrace);
        const trimmedPrelude = prelude.trim();
        const statementEnd = findNextCssStatementEnd(css, cursor);
        if (statementEnd !== nextBrace) {
            const statement = css.slice(cursor, statementEnd + 1);
            if (!statement.trim().startsWith('@')) {
                output += statement;
            }
            cursor = statementEnd + 1;
            continue;
        }

        const blockEnd = findCssBlockEnd(css, nextBrace);
        if (blockEnd === -1) {
            break;
        }

        const block = css.slice(nextBrace + 1, blockEnd);
        const atRuleName = trimmedPrelude.match(/^@([a-z-]+)/i)?.[1]?.toLowerCase();

        if (atRuleName === 'media' || atRuleName === 'supports' || atRuleName === 'container') {
            output += `${prelude}{${scopeWidgetCss(block, hostSelector)}}`;
        } else if (atRuleName === 'keyframes' || atRuleName === '-webkit-keyframes') {
            output += `${prelude}{${block}}`;
        } else if (!atRuleName) {
            const scopedSelector = splitCssSelectorList(prelude)
                .map((selector) => scopeCssSelector(selector, hostSelector))
                .filter(Boolean)
                .join(', ');
            if (scopedSelector) {
                output += `${scopedSelector}{${block}}`;
            }
        }

        cursor = blockEnd + 1;
    }

    return output.trim();
}

function scopeStyleElements(fragment: DocumentFragment, hostSelector: string): void {
    for (const styleElement of fragment.querySelectorAll('style')) {
        styleElement.textContent = scopeWidgetCss(styleElement.textContent ?? '', hostSelector);
    }
}

function parseRenderTree(
    rawHtml: string,
    hostSelector: string,
    phase: ShowWidgetPhase = 'ready'
): ParsedRenderTree {
    const template = document.createElement('template');
    const sanitizedHtml = sanitizeDraftHtml(rawHtml, phase);
    const normalizedHtml = sanitizedHtml || '<div></div>';
    const isFullDocument = /<(?:!doctype|html|head|body)\b/i.test(normalizedHtml);

    // Explicit <script> blocks are executable widget code. Some legitimate
    // widget scripts contain template strings with SVG/HTML snippets, which
    // DOMPurify may drop as unsafe script text. Capture scripts before
    // sanitizing markup, then run the captured classic scripts after the
    // sanitized DOM has been mounted.
    const purifyConfig = { ADD_TAGS: ['style'], FORCE_BODY: true };
    let htmlForSanitizer: string;
    let scripts: WidgetScriptSnapshot[];

    if (isFullDocument) {
        const parser = new DOMParser();
        const parsed = parser.parseFromString(normalizedHtml, 'text/html');
        normalizeWidgetActionAttributesIn(parsed.body);
        scripts = extractWidgetScripts(parsed.body);
        const headStyleHtml = Array.from(parsed.head.querySelectorAll('style'))
            .map((style) => style.outerHTML)
            .join('');
        htmlForSanitizer = `${headStyleHtml}${parsed.body.innerHTML || '<div></div>'}`;
    } else {
        const preSanitizeTemplate = document.createElement('template');
        preSanitizeTemplate.innerHTML = normalizedHtml;
        normalizeWidgetActionAttributesIn(preSanitizeTemplate.content);
        scripts = extractWidgetScripts(preSanitizeTemplate.content);
        htmlForSanitizer = preSanitizeTemplate.innerHTML;
    }

    template.innerHTML = String(DOMPurify.sanitize(htmlForSanitizer, purifyConfig));

    if (!isFullDocument) {
        if (!template.content.childNodes.length) {
            template.innerHTML = '<div></div>';
        }
    }

    scopeStyleElements(template.content, hostSelector);

    return {
        fragment: template.content,
        scripts,
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

function applyShowWidgetLayoutGuards(hostElement: HTMLElement, widgetRoot: HTMLElement): void {
    hostElement.style.width = '100%';
    hostElement.style.maxWidth = `${SHOW_WIDGET_MAX_WIDTH_PX}px`;
    hostElement.style.minWidth = '0';
    hostElement.style.marginLeft = 'auto';
    hostElement.style.marginRight = 'auto';
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

function normalizeShowWidgetExternalUrl(url: string): string | null {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
        return null;
    }

    if (!/^(?:https?:)?\/\//i.test(trimmedUrl)) {
        return null;
    }

    try {
        const parsedUrl = new URL(trimmedUrl, window.location.href);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return null;
        }

        return parsedUrl.href;
    } catch {
        return null;
    }
}

function openShowWidgetLink(url: string): void {
    const externalUrl = normalizeShowWidgetExternalUrl(url);
    if (!externalUrl) {
        return;
    }

    if (typeof window.openLink === 'function') {
        window.openLink(externalUrl);
        return;
    }

    window.open(externalUrl, '_blank', 'noopener,noreferrer');
}

function sendShowWidgetPrompt(prompt: string): void {
    if (!prompt.trim() || typeof window.sendPrompt !== 'function') {
        return;
    }

    window.sendPrompt(prompt);
}

function clearApplyTimer(state: ShowWidgetRendererState): void {
    if (state.applyTimer !== null) {
        window.clearTimeout(state.applyTimer);
        state.applyTimer = null;
    }
}

export function createWidgetRenderer(hostElement: HTMLElement): WidgetRenderer {
    const scopeId = `touchai-widget-${crypto.randomUUID()}`;
    const hostSelector = `[data-touchai-widget-host="${scopeId}"]`;
    const state: ShowWidgetRendererState = {
        destroyed: false,
        pendingPayload: null,
        applyTimer: null,
        lastDraftAppliedAt: 0,
        hasAppliedMeaningfulDraft: false,
    };
    let frameReady = false;
    let lastPayload: ShowWidgetRenderPayload | null = null;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('data-touchai-widget-frame', 'true');
    frame.style.border = '0';
    frame.style.display = 'block';
    frame.style.height = '24px';
    frame.style.background = 'transparent';
    hostElement.dataset.touchaiWidgetHost = scopeId;
    hostElement.dataset.widgetPhase = 'draft';
    hostElement.setAttribute('data-no-i18n', 'true');
    hostElement.setAttribute('translate', 'no');
    ensureShowWidgetThemeVariables(hostElement);
    const theme = Object.keys(SHOW_WIDGET_THEME_FALLBACKS)
        .map((name) => `${name}: ${hostElement.style.getPropertyValue(name)};`)
        .join('');
    frame.srcdoc = createWidgetSandboxDocument(
        scopeId,
        `:root{${theme}}${createShowWidgetBaseStyles(hostSelector)}`
    );
    hostElement.replaceChildren(frame);
    applyShowWidgetLayoutGuards(hostElement, frame);

    function applyPayload(payload: ShowWidgetRenderPayload): boolean {
        const tree = parseRenderTree(payload.html, hostSelector, payload.phase);
        if (payload.phase === 'draft' && !hasMeaningfulContent(tree.fragment)) return false;
        const root = document.createElement('div');
        root.append(tree.fragment);
        applyShowWidgetLayoutGuards(hostElement, root);
        const scripts =
            payload.phase === 'ready'
                ? tree.scripts.filter((script) =>
                      script.src
                          ? isShowWidgetScriptUrlAllowed(script.src)
                          : SHOW_WIDGET_CLASSIC_SCRIPT_TYPES.has(script.type)
                  )
                : [];
        frame.contentWindow?.postMessage(
            {
                type: 'render',
                scopeId,
                phase: payload.phase,
                html: root.innerHTML,
                scripts,
                signature: payload.html,
            },
            '*'
        );
        return true;
    }

    function flushPendingPayload() {
        if (state.destroyed || !frameReady || !state.pendingPayload) return;
        const payload = state.pendingPayload;
        state.pendingPayload = null;
        if (applyPayload(payload) && payload.phase === 'draft') {
            state.lastDraftAppliedAt = Date.now();
            state.hasAppliedMeaningfulDraft = true;
        }
    }
    function handleLoad() {
        if (state.destroyed) return;
        frameReady = true;
        state.pendingPayload = lastPayload;
        clearApplyTimer(state);
        flushPendingPayload();
    }
    function handleMessage(event: MessageEvent) {
        if (
            state.destroyed ||
            event.source !== frame.contentWindow ||
            !event.data ||
            typeof event.data !== 'object'
        )
            return;
        const data = event.data as Record<string, unknown>;
        if (data.source !== 'touchai-show-widget' || data.scopeId !== scopeId) return;
        if (
            data.type === 'resize' &&
            typeof data.height === 'number' &&
            Number.isFinite(data.height)
        ) {
            frame.style.height = `${Math.max(24, Math.min(2400, Math.ceil(data.height)))}px`;
        } else if (
            data.type === 'sendPrompt' &&
            typeof data.text === 'string' &&
            data.text.length <= 20_000
        ) {
            sendShowWidgetPrompt(data.text);
        } else if (
            data.type === 'openLink' &&
            typeof data.url === 'string' &&
            data.url.length <= 4096
        ) {
            openShowWidgetLink(data.url);
        }
    }
    frame.addEventListener('load', handleLoad);
    window.addEventListener('message', handleMessage);
    return {
        render(payload) {
            if (state.destroyed) return;
            hostElement.dataset.widgetPhase = payload.phase;
            hostElement.dataset.widgetId = payload.widgetId;
            hostElement.title = payload.title;
            const title = payload.title || payload.description || 'ShowWidget';
            hostElement.setAttribute('aria-label', title);
            frame.title = title;
            lastPayload = payload;
            state.pendingPayload = payload;
            if (payload.phase === 'ready' || !state.hasAppliedMeaningfulDraft) {
                clearApplyTimer(state);
                flushPendingPayload();
            } else if (state.applyTimer === null) {
                const delay = Math.max(
                    0,
                    SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS - (Date.now() - state.lastDraftAppliedAt)
                );
                state.applyTimer = window.setTimeout(() => {
                    state.applyTimer = null;
                    flushPendingPayload();
                }, delay);
            }
        },
        destroy() {
            state.destroyed = true;
            state.pendingPayload = null;
            lastPayload = null;
            clearApplyTimer(state);
            frame.removeEventListener('load', handleLoad);
            window.removeEventListener('message', handleMessage);
            // Removing the iframe also tears down timers, frames, observers, and
            // listeners created by generated code in its isolated realm.
            hostElement.replaceChildren();
            delete hostElement.dataset.touchaiWidgetHost;
            delete hostElement.dataset.widgetPhase;
            delete hostElement.dataset.widgetId;
            hostElement.removeAttribute('title');
            hostElement.removeAttribute('aria-label');
        },
    };
}
