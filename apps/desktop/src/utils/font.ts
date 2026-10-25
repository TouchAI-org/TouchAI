// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import { AppEvent, eventService } from '@services/EventService';
import { paths } from '@services/NativeService';
import { convertFileSrc } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';

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

        if (typeof fetch === 'function') {
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
        console.info('Source Han Serif font ready:', diagnostics);
    } else {
        console.warn('Source Han Serif font diagnostics:', diagnostics);
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
     * `format('woff2 supports variations')` is required here, not optional decoration.
     *
     * The file is Source Han Serif SC VF, a variable font: `fvar` declares `wght`
     * 250..900 with named instances at 250, 300, 400, 500, 600, 700 and 900. Without
     * the `supports variations` hint the engine loads the file as a static face and
     * then finds no instance for the weight the page asks for. It does not error — it
     * silently falls back to whatever `serif` resolves to.
     *
     * That silent fallback is why the interface spent its life in the wrong typeface.
     * On Windows `serif` resolves to an installed CJK serif, so the text still looked
     * like a serif and nobody noticed; the shipped font was never painted at all.
     * `document.fonts.check()` returned `true` throughout, and the face reported
     * `status: "loaded"`, because the bytes did download and parse.
     *
     * Measured in the app with the same file and the same family name, comparing the
     * rendered Han glyphs against the installed `Noto Serif SC` that `serif` resolves
     * to (0 pixels apart from each other, so they are the same face):
     *
     *     format('woff2')                        -> 49 pixels differ   (fallback)
     *     format('woff2-variations')             -> 49 pixels differ   (fallback)
     *     no format hint                         -> 49 pixels differ   (fallback)
     *     font-weight: 400 instead of the range  -> 49 pixels differ   (fallback)
     *     format('woff2 supports variations')    -> 3971 pixels differ (product face)
     *
     * So the weight range below is correct and is not the cause; the format hint is.
     * Keep both: the range is what lets the axis interpolate once the file is accepted.
     */
    style.textContent = `
        @font-face {
            font-family: '${FONT_FACE_FAMILY}';
            src: url('${fontUrl}') format('woff2 supports variations');
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
    console.error('Failed to load Source Han Serif font:', error);
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
            console.error('Failed to listen for font-ready event:', error);
        });

    return fontReadyListenerPromise;
}

export function initializeFontLoader(): void {
    ensureFontReadyListener().finally(() => {
        void loadFontFace({ requireExistingFile: true }).catch(logFontLoadError);
    });
}
