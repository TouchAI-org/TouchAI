// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import { AppEvent, eventService } from '@services/EventService';
import { paths } from '@services/NativeService';
import { log } from '@services/ObservabilityService';
import { convertFileSrc } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';

import { scheduleCjkGlyphWarmup } from './font/glyphWarmup';

const FONT_FILENAME = 'SourceHanSerifSC-VF.ttf.woff2';
const FONT_FACE_FAMILY = 'TouchAI Source Han Serif SC';
const FONT_FACE_STYLE_ATTRIBUTE = 'data-touchai-font-face';
const FONT_FACE_STYLE_KEY = 'source-han-serif-sc';
const FONT_LOAD_TEST = `16px '${FONT_FACE_FAMILY}'`;
const FONT_LOAD_ATTEMPTS = 3;
const FONT_LOAD_RETRY_DELAY_MS = 16;

let fontLoadPromise: Promise<void> | null = null;
let fontReadyListenerPromise: Promise<void> | null = null;
let fontReloadToken = 0;

interface LoadFontFaceOptions {
    refresh?: boolean;
    requireExistingFile?: boolean;
}

interface FontLoadDiagnostics {
    fontUrl: string;
    fontLoaded: boolean;
    fontsApiAvailable: boolean;
    fetchOk?: boolean;
    fetchStatus?: number;
    fetchStatusText?: string;
    contentType?: string | null;
    userAgent: string;
    error?: string;
}

function getInjectedFontFaceStyle(): HTMLStyleElement | null {
    return document.head.querySelector<HTMLStyleElement>(
        `style[${FONT_FACE_STYLE_ATTRIBUTE}="${FONT_FACE_STYLE_KEY}"]`
    );
}

function hasInjectedFontFace(): boolean {
    return getInjectedFontFaceStyle() !== null;
}

function appendFontReloadToken(fontUrl: string, reloadToken: number): string {
    const separator = fontUrl.includes('?') ? '&' : '?';
    return `${fontUrl}${separator}touchaiFontReload=${reloadToken}`;
}

function stringifyError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

async function waitForStyleProcessing(): Promise<void> {
    await Promise.resolve();

    await new Promise<void>((resolve) => {
        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => resolve());
            return;
        }

        window.setTimeout(resolve, 0);
    });
}

async function resolveFontPath(): Promise<string> {
    const fontDir = await paths.getAppDirectoryPath('ASSETS_FONT');
    return join(fontDir, FONT_FILENAME);
}

async function verifyInjectedFontFace(fontUrl: string): Promise<void> {
    const diagnostics: FontLoadDiagnostics = {
        fontUrl,
        fontLoaded: false,
        fontsApiAvailable:
            typeof document.fonts?.load === 'function' &&
            typeof document.fonts?.check === 'function',
        userAgent: navigator.userAgent,
    };

    try {
        if (diagnostics.fontsApiAvailable) {
            await waitForStyleProcessing();

            for (let attempt = 0; attempt < FONT_LOAD_ATTEMPTS; attempt += 1) {
                if (attempt > 0) {
                    await delay(FONT_LOAD_RETRY_DELAY_MS);
                }

                await document.fonts.load(FONT_LOAD_TEST);
                diagnostics.fontLoaded = document.fonts.check(FONT_LOAD_TEST);

                if (diagnostics.fontLoaded) {
                    break;
                }
            }
        }

        // 字体已由浏览器 Fonts API 确认可用时跳过文件探测：
        // 重复请求会把整个字体文件再拉一遍，只在失败或无 Fonts API 时才需要诊断。
        const shouldProbeFontFile = !diagnostics.fontLoaded || !diagnostics.fontsApiAvailable;
        if (shouldProbeFontFile && typeof fetch === 'function') {
            const response = await fetch(fontUrl);
            diagnostics.fetchOk = response.ok;
            diagnostics.fetchStatus = response.status;
            diagnostics.fetchStatusText = response.statusText;
            diagnostics.contentType = response.headers.get('content-type');
        }
    } catch (error) {
        diagnostics.error = stringifyError(error);
    }

    if (diagnostics.fontLoaded && diagnostics.fetchOk !== false) {
        log.info('Source Han Serif font ready:', diagnostics);
    } else {
        log.warn('Source Han Serif font diagnostics:', diagnostics);
    }
}

async function injectFontFace(options: LoadFontFaceOptions = {}): Promise<boolean> {
    const { refresh = false, requireExistingFile = false } = options;

    if (!refresh && hasInjectedFontFace()) {
        return true;
    }

    const fontPath = await resolveFontPath();
    if (requireExistingFile && !(await exists(fontPath))) {
        return false;
    }

    const fontUrl = refresh
        ? appendFontReloadToken(convertFileSrc(fontPath), ++fontReloadToken)
        : convertFileSrc(fontPath);

    if (!refresh && hasInjectedFontFace()) {
        return true;
    }

    const style = document.createElement('style');
    style.setAttribute(FONT_FACE_STYLE_ATTRIBUTE, FONT_FACE_STYLE_KEY);
    /*
     * The `format()` hint decides whether this variable font is painted at all.
     *
     * The file is Source Han Serif SC VF: `fvar` declares `wght` 250..900 with named
     * instances at 250, 300, 400, 500, 600, 700 and 900. An engine that is not told the
     * file carries a variation axis loads it as a static face, finds no instance for the
     * weight the page asks for, and silently substitutes whatever `serif` resolves to.
     * Nothing throws: `document.fonts.check()` still returns `true` and the face still
     * reports `status: "loaded"`, because the bytes downloaded and parsed fine. That
     * silent substitution is why the interface was never painted in the font it ships.
     *
     * `format('woff2-variations')` is the form CSS Fonts 4 defines for this. The spec's
     * compatibility table maps it to the modern `tech()` syntax and keeps it valid
     * permanently:
     *
     *     format("woff2-variations")  ==  format(woff2) tech(variations)
     *
     * An earlier version of this rule used `format('woff2 supports variations')`. That
     * string is not in the specification: `<font-format>` accepts only `woff2`, `woff`,
     * `opentype` and friends, and the variation requirement is expressed through
     * `<font-tech>`. It came from articles describing a pre-2018 draft. Chromium 156
     * parses it leniently enough to work, Chromium 155 rejects the whole `src` entry, so
     * the same rule rendered the font on a developer machine and fell back on CI.
     *
     * Measured in WebView2 156 with the app's own file, comparing the painted outline
     * against a face built directly from those bytes: `woff2-variations` agrees within
     * 3 pixels of anti-aliasing, while the unsupported string produces no face at all.
     *
     * The weight range below is what lets the axis interpolate once the file is
     * accepted; keep it.
     */
    style.textContent = `
        @font-face {
            font-family: '${FONT_FACE_FAMILY}';
            src: url('${fontUrl}') format('woff2-variations');
            font-weight: 250 900;
            font-style: normal;
            font-display: swap;
        }
    `;
    getInjectedFontFaceStyle()?.remove();
    document.head.appendChild(style);

    await verifyInjectedFontFace(fontUrl);
    return true;
}

function loadFontFace(options: LoadFontFaceOptions = {}): Promise<void> {
    const { refresh = false } = options;

    if (!refresh && hasInjectedFontFace()) {
        return Promise.resolve();
    }

    if (!refresh && fontLoadPromise) {
        return fontLoadPromise;
    }

    const loadPromise = injectFontFace(options)
        .then(() => undefined)
        .finally(() => {
            fontLoadPromise = null;
        });

    if (refresh) {
        return loadPromise;
    }

    fontLoadPromise = loadPromise;
    return fontLoadPromise;
}

function logFontLoadError(error: unknown): void {
    log.error('Failed to load Source Han Serif font:', error);
}

function ensureFontReadyListener(): Promise<void> {
    if (fontReadyListenerPromise) {
        return fontReadyListenerPromise;
    }

    fontReadyListenerPromise = eventService
        .on(AppEvent.FONT_READY, () => {
            void loadFontFace({ refresh: true }).catch(logFontLoadError);
        })
        .then(() => undefined)
        .catch((error) => {
            fontReadyListenerPromise = null;
            log.error('Failed to listen for font-ready event:', error);
        });

    return fontReadyListenerPromise;
}

export function initializeFontLoader(): void {
    ensureFontReadyListener().finally(() => {
        void loadFontFace({ requireExistingFile: true })
            .then(() => {
                // 字体就绪后同步把字形缓存预热掉：
                // 否则“首次看到大量中文”的那一帧要把 500ms+ 花在 shaping 上。
                scheduleCjkGlyphWarmup();
            })
            .catch(logFontLoadError);
    });
}
